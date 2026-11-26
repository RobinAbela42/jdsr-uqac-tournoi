// Test de bout en bout de l'API (stockage mémoire) : node scripts/test-flow.js
import http from 'node:http';
import assert from 'node:assert/strict';
import handler from '../api/rpc.js';

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
const getState = async () => (await fetch(base)).json();
const ok = (r) => {
  if (r.error) throw new Error(r.error);
  return r;
};

try {
  assert.equal((await call('start', {})).status, 401, 'start sans mot de passe refusé');
  assert.equal((await call('register', { pseudo: 'Bob' })).error, "Aucun jeu n'est encore ouvert.");

  const g1 = ok(await admin('createGame', { game: { name: 'Catan', capacity: 4, minPlayers: 3 } })).result;
  const g2 = ok(await admin('createGame', { game: { name: 'Codenames', capacity: 6, minPlayers: 4 } })).result;
  const g3 = ok(await admin('createGame', { game: { name: 'Uno', capacity: 4, minPlayers: 2 } })).result;
  assert.equal((await admin('createGame', { game: { name: 'X', capacity: 2, minPlayers: 3 } })).status, 400);

  // 14 inscriptions simultanées (14 places au total)
  const names = Array.from({ length: 14 }, (_, i) => 'Joueur' + (i + 1));
  const regs = await Promise.all(names.map((pseudo) => call('register', { pseudo })));
  regs.forEach(ok);
  let st = await getState();
  assert.equal(st.activePlayers, 14, 'aucune inscription perdue en parallèle');
  assert.equal((await call('register', { pseudo: 'joueur1' })).error, 'Ce pseudo est déjà pris.');
  assert.equal((await call('register', { pseudo: 'Extra' })).error, 'Plus de place : le tournoi est complet.');

  const me = regs[0].result;
  assert.equal(ok(await call('whoami', { token: me.token })).result.pseudo, 'Joueur1');
  assert.equal(ok(await call('whoami', { token: 'faux' })).result, null);

  // un joueur part, un autre arrive
  ok(await call('leave', { token: regs[13].result.token }));
  ok(await call('register', { pseudo: 'Retardataire' }));

  ok(await admin('start'));
  st = await getState();
  assert.equal(st.status, 'running');
  assert.equal(st.currentRound, 0);
  assert.ok(st.rounds.length >= 3);
  assert.equal(st.players[0].token, undefined, 'tokens jamais exposés');
  for (const r of st.rounds) {
    const ids = r.tables.flatMap((t) => t.playerIds);
    assert.equal(new Set(ids).size, 14, 'chaque joueur une fois par étape');
  }
  assert.equal((await call('register', { pseudo: 'Tard' })).error, 'Les inscriptions sont fermées.');

  // points
  const r0 = st.rounds[0];
  for (const t of r0.tables) for (const [i, pid] of t.playerIds.entries()) ok(await admin('setScore', { round: 0, playerId: pid, points: 3 - i }));
  ok(await admin('next'));
  ok(await admin('next'));
  ok(await admin('prev'));
  st = await getState();
  assert.equal(st.currentRound, 1);

  // modifier un jeu pendant le tournoi : l'historique (étapes 0 et 1) ne bouge pas
  const before = JSON.stringify(st.rounds.slice(0, 2));
  ok(await admin('updateGame', { id: g3.id, game: { capacity: 5 } }));
  st = await getState();
  assert.equal(JSON.stringify(st.rounds.slice(0, 2)), before, 'historique conservé');
  assert.equal((await admin('updateGame', { id: g2.id, game: { capacity: 4 } })).status, 400, 'refus si plus assez de places');

  // retirer un joueur
  const victim = st.players.find((p) => p.pseudo === 'Joueur5');
  ok(await admin('removePlayer', { id: victim.id }));
  st = await getState();
  assert.ok(!st.rounds[st.currentRound + 1].tables.some((t) => t.playerIds.includes(victim.id)));

  // avancer au-delà du planning calculé => extension automatique
  const n = st.rounds.length;
  for (let i = st.currentRound; i < n + 1; i++) ok(await admin('next'));
  st = await getState();
  assert.ok(st.rounds.length > n && st.currentRound < st.rounds.length);

  ok(await admin('finish'));
  st = await getState();
  assert.equal(st.status, 'finished');
  assert.equal(st.ranking[0].rank, 1);
  console.log('Classement :', st.ranking.slice(0, 4).map((p) => `${p.rank}. ${p.pseudo} (${p.total})`).join(', '));

  ok(await admin('resetTournament', { keepPlayers: true }));
  st = await getState();
  assert.equal(st.status, 'registration');
  assert.equal(st.activePlayers, 13);
  assert.equal(st.games.length, 3);
  console.log('Parcours complet OK');
} finally {
  server.close();
}
