// Stockage de l'état du tournoi.
// - En production : Upstash Redis via son API REST (aucune dépendance npm).
//   Variables reconnues : KV_REST_API_URL / KV_REST_API_TOKEN (intégration Vercel)
//   ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
// - Sans ces variables : stockage en mémoire (dev local uniquement).
//
// Tout l'état tient dans une seule clé JSON. Les écritures utilisent un
// "compare-and-set" sur un numéro de version (script Lua atomique), ce qui
// évite de perdre des inscriptions quand plusieurs joueurs s'inscrivent en même temps.

const STATE_KEY = 'jds:state';
const VERSION_KEY = 'jds:version';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const storeKind = REDIS_URL && REDIS_TOKEN ? 'redis' : 'memory';

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error('Redis: ' + (data.error || res.status));
  return data.result;
}

const CAS_SCRIPT = `
local v = redis.call('GET', KEYS[2]) or '0'
if v == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return redis.call('INCR', KEYS[2])
end
return -1`;

// --- Mémoire (dev) -------------------------------------------------------
const mem = globalThis.__jdsMem || (globalThis.__jdsMem = { state: null, version: 0 });

async function readRaw() {
  if (storeKind === 'memory') return { json: mem.state, version: String(mem.version) };
  const [json, version] = await redis(['MGET', STATE_KEY, VERSION_KEY]);
  return { json, version: version || '0' };
}

async function casWrite(expectedVersion, json) {
  if (storeKind === 'memory') {
    if (String(mem.version) !== expectedVersion) return false;
    mem.state = json;
    mem.version++;
    return true;
  }
  const r = await redis(['EVAL', CAS_SCRIPT, '2', STATE_KEY, VERSION_KEY, expectedVersion, json]);
  return r !== -1;
}

export async function readState(initial) {
  const { json, version } = await readRaw();
  const state = json ? JSON.parse(json) : initial();
  return { state, version: Number(version) };
}

// Applique fn(state) de façon atomique. fn modifie l'état et peut renvoyer un résultat.
// Si quelqu'un a écrit entre-temps, on relit et on recommence.
export async function updateState(initial, fn) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { json, version } = await readRaw();
    const state = json ? JSON.parse(json) : initial();
    const result = await fn(state);
    if (await casWrite(version, JSON.stringify(state))) {
      return { state, result, version: Number(version) + 1 };
    }
    await new Promise((r) => setTimeout(r, 20 + Math.random() * (60 + attempt * 40)));
  }
  throw new Error('Trop de modifications simultanées, réessaie.');
}
