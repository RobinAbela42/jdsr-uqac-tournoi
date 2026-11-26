// Test des jeux spéciaux (Codenames, Secret Hitler) et des points rapides : node scripts/test-special.js
import http from 'node:http';
import assert from 'node:assert/strict';
import handler from '../api/rpc.js';

globalThis.__jdsMem.state = null; // repartir d'un état vide
const server = http.createServer((req, res) => handler(req, res)).listen(0);
const base = `http://localhost:${server.address().port}/api/rpc`;
async function call(action, params = {}, admin = false) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-password': 'admin' } : {}) },
    body: JSON.stringify({ action, ...params }),
  });
  return { status: res.status, ...(await res.json()) };
}
const admin = (a, p) => call(a, p, true);
const ok = (r) => {
  if (r.error) throw new Error(r.error);
  return r;
};
const pub = async () => (await fetch(base)).json();
const full = async () => (await fetch(base, { headers: { 'x-admin-password': 'admin' } })).json();

try {
  // Bibliothèque
  const cn = ok(await admin('createGame', { game: { type: 'codenames', name: 'Codenames', capacity: 6, minPlayers: 4 } })).result;
  const sh = ok(await admin('createGame', { game: { type: 'secret-hitler', name: 'Secret Hitler', capacity: 7, minPlayers: 5 } })).result;
  ok(await admin('createGame', { game: { name: 'Uno', capacity: 4, minPlayers: 2 } }));
  assert.equal((await admin('createGame', { game: { type: 'codenames', name: 'CN', capacity: 3, minPlayers: 2 } })).status, 400, 'Codenames : 4 places min');
  assert.equal(sh.config.hitler, 3);
  assert.equal(sh.config.countsResult, true);

  const P = {};
  for (const n of ['Ana', 'Ben', 'Cléo', 'Dan', 'Eva', 'Fred', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kim', 'Lou', 'Mo', 'Nils', 'Oda', 'Pia']) P[n] = ok(await call('register', { pseudo: n })).result;

  // Équipes : max 6/2 = 3
  ok(await call('joinTeam', { token: P.Ben.token, gameId: cn.id, withPlayerId: P.Ana.id }));
  ok(await call('joinTeam', { token: P.Cléo.token, gameId: cn.id, withPlayerId: P.Ana.id }));
  assert.match((await call('joinTeam', { token: P.Dan.token, gameId: cn.id, withPlayerId: P.Ben.id })).error, /complète/);
  ok(await call('joinTeam', { token: P.Eva.token, gameId: cn.id, withPlayerId: P.Dan.id }));
  ok(await call('joinTeam', { token: P.Gus.token, gameId: cn.id, withPlayerId: P.Fred.id }));
  ok(await call('joinTeam', { token: P.Gus.token, gameId: cn.id, withPlayerId: P.Hana.id })); // change d'équipe
  let st = await pub();
  const teams = st.games.find((g) => g.id === cn.id).teams;
  assert.equal(teams.length, 3, '3 équipes (Fred seul = équipe dissoute)');
  ok(await call('leaveTeam', { token: P.Hana.token, gameId: cn.id }));
  st = await pub();
  assert.equal(st.games.find((g) => g.id === cn.id).teams.length, 2);
  ok(await call('joinTeam', { token: P.Hana.token, gameId: cn.id, withPlayerId: P.Gus.id }));

  ok(await admin('start'));
  st = await full();
  assert.match((await call('joinTeam', { token: P.Ivo.token, gameId: cn.id, withPlayerId: P.Jo.id })).error, /verrouillées/);

  // Équipes jamais séparées, camps présents
  const finalTeams = st.games.find((g) => g.id === cn.id).teams;
  for (const r of st.rounds)
    for (const t of r.tables.filter((t) => t.gameId === cn.id)) {
      assert.ok(t.sides, 'camps calculés');
      for (const team of finalTeams) {
        const inside = team.filter((p) => t.playerIds.includes(p)).length;
        assert.ok(inside === 0 || inside === team.length, 'équipe ensemble');
        const side = t.sides.findIndex((s) => s.includes(team[0]));
        if (inside) assert.ok(team.every((p) => t.sides[side].includes(p)), 'équipe dans le même camp');
      }
    }

  // Secret Hitler : trouver une étape où il est joué
  let r = st.currentRound;
  while (!st.rounds[r].tables.some((t) => t.gameId === sh.id)) {
    ok(await admin('next'));
    st = await full();
    r = st.currentRound;
  }
  const shTable = st.rounds[r].tables.find((t) => t.gameId === sh.id);
  const tok = (id) => Object.values(P).find((p) => p.id === id).token;
  const [h, f, ...libs] = shTable.playerIds;
  ok(await call('tableChoice', { token: tok(h), gameId: sh.id, key: 'role', value: 'hitler' }));
  ok(await call('tableChoice', { token: tok(f), gameId: sh.id, key: 'role', value: 'fasciste' }));
  for (const l of libs.slice(0, -1)) ok(await call('tableChoice', { token: tok(l), gameId: sh.id, key: 'role', value: 'liberal' }));
  // le dernier libéral oublie de déclarer
  assert.equal((await call('tableChoice', { token: tok(h), gameId: sh.id, key: 'role', value: 'roi' })).status, 400);
  const outsider = Object.values(P).find((p) => !shTable.playerIds.includes(p.id));
  assert.equal((await call('tableChoice', { token: outsider.token, gameId: sh.id, key: 'role', value: 'liberal' })).status, 400);

  // rôles cachés aux joueurs pendant l'étape, visibles par l'admin
  const k = `${r}:${sh.id}`;
  assert.equal((await pub()).tableData[k].players[h].role, 'déclaré');
  assert.equal((await full()).tableData[k].players[h].role, 'hitler');
  const me = ok(await call('whoami', { token: tok(h) })).result;
  assert.equal(me.myChoices[sh.id].role, 'hitler');

  ok(await call('tableChoice', { token: tok(f), gameId: sh.id, key: 'winner', value: 'fasciste' }));
  // l'admin corrige manuellement un joueur avant la fin : ce score ne doit pas être écrasé
  ok(await admin('setScore', { round: r, playerId: libs[0], points: 7 }));

  const res = ok(await admin('next'));
  assert.ok(res.result.warnings.some((w) => /rôle manquant/.test(w)), 'avertissement rôle manquant');
  st = await full();
  assert.equal(st.scores[r][h], 3, 'Hitler gagnant = 3');
  assert.equal(st.scores[r][f], 2, 'Fasciste gagnant = 2');
  assert.equal(st.scores[r][libs[0]], 7, 'saisie manuelle conservée');
  if (libs.length > 2) assert.equal(st.scores[r][libs[1]], 0, 'libéral perdant = 0');
  assert.equal((await pub()).tableData[k].players[h].role, 'hitler', 'rôles révélés après l’étape');

  // l'admin corrige le camp gagnant après coup -> points recalculés
  ok(await admin('adminTableChoice', { round: r, gameId: sh.id, key: 'winner', value: 'liberal' }));
  st = await full();
  assert.equal(st.scores[r][h], 0);
  if (libs.length > 2) assert.equal(st.scores[r][libs[1]], 2);

  // Boutons +1 / -1 : 10 clics simultanés
  const target = libs[0];
  await Promise.all(Array.from({ length: 10 }, () => admin('addScore', { round: r, playerId: target, delta: 1 })));
  ok(await admin('addScore', { round: r, playerId: target, delta: -1 }));
  st = await full();
  assert.equal(st.scores[r][target], 16, '7 + 10 - 1');

  // --- Score entré par le joueur -------------------------------------------
  st = await full();
  const cr = st.currentRound;
  const tables = st.rounds[cr].tables;
  const normal = tables.find((t) => t.gameId !== sh.id);
  const pj = normal.playerIds[0];
  ok(await call('setMyScore', { token: tok(pj), points: 4 }));
  ok(await call('setMyScore', { token: tok(pj), points: 5.5 }));
  st = await full();
  assert.equal(st.scores[cr][pj], 5.5);
  assert.equal(st.scoreBy[cr][pj], 'player');
  assert.equal((await call('setMyScore', { token: tok(pj), points: 'abc' })).status, 400);
  const shNow = tables.find((t) => t.gameId === sh.id);
  if (shNow) assert.match((await call('setMyScore', { token: tok(shNow.playerIds[0]), points: 3 })).error, /automatiquement/);
  // l'admin corrige -> marqué admin
  ok(await admin('addScore', { round: cr, playerId: pj, delta: 1 }));
  st = await full();
  assert.equal(st.scores[cr][pj], 6.5);
  assert.equal(st.scoreBy[cr][pj], 'admin');
  // effacer son score
  ok(await call('setMyScore', { token: tok(pj), points: null }));
  st = await full();
  assert.equal(st.scores[cr][pj], undefined);

  // --- Ajustements live (section Joueurs) -----------------------------------
  const avant = st.players.find((p) => p.id === pj).total;
  await Promise.all(Array.from({ length: 5 }, () => admin('adjustPlayer', { playerId: pj, delta: 1 })));
  ok(await admin('adjustPlayer', { playerId: pj, delta: -2.5 }));
  assert.equal((await admin('adjustPlayer', { playerId: pj, delta: 0 })).status, 400);
  st = await pub();
  const pp = st.players.find((p) => p.id === pj);
  assert.equal(pp.adjustment, 2.5);
  assert.equal(pp.total, avant + 2.5, 'ajustement compté dans le total');
  assert.equal(st.ranking.find((p) => p.id === pj).total, avant + 2.5);
  assert.equal((await call('adjustPlayer', { playerId: pj, delta: 1 })).status, 401, 'réservé aux admins');

  // un score joueur n'est pas écrasé par le calcul auto, et on ne peut plus le changer à l'étape suivante
  ok(await call('setMyScore', { token: tok(pj), points: 2 }));
  ok(await admin('next'));
  st = await full();
  assert.equal(st.scores[cr][pj], 2);
  const t2 = st.rounds[st.currentRound].tables.find((t) => t.playerIds.includes(pj));
  if (t2 && t2.gameId !== sh.id) {
    ok(await call('setMyScore', { token: tok(pj), points: 9 }));
    st = await full();
    assert.equal(st.scores[cr][pj], 2, "l'étape précédente ne bouge plus");
    assert.equal(st.scores[st.currentRound][pj], 9);
  }

  // reset : ajustements effacés
  ok(await admin('resetTournament', { keepPlayers: true }));
  assert.equal((await pub()).players.find((p) => p.id === pj).total, 0);

  console.log('Jeux spéciaux OK');
} finally {
  server.close();
}
