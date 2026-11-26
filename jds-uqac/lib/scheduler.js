// Algorithme de répartition des joueurs.
//
// Contraintes strictes (jamais violées) :
//   - une table est soit vide, soit entre son minimum et son maximum de joueurs ;
//   - chaque joueur est à une table, ou « en pause » si les minimums rendent
//     impossible de placer tout le monde (ex. 9 joueurs et seulement des jeux de 4 places).
//     Le nombre de joueurs en pause est toujours le plus petit possible.
//
// Coût minimisé (recuit simulé) :
//   - rejouer à un jeu déjà joué (de plus en plus cher), donc on varie les jeux le plus longtemps possible ;
//   - rejouer le même jeu deux étapes de suite ;
//   - retrouver quelqu'un déjà rencontré ;
//   - être en pause (cher, et de plus en plus si ça se répète) ;
//   - les règles propres à chaque type de jeu (gameTypes.js : équipes, camps…).
//
// Étapes :
//   1. pour chaque étape, on tire plusieurs « formes » valides (combien de joueurs à
//      chaque table) et on remplit chacune de façon gloutonne ; on garde la meilleure ;
//   2. on optimise toutes les étapes ensemble : échanges de joueurs, déplacements,
//      déplacements d'équipe, et changements de forme d'une étape (ex. passer de
//      « 4 + 4 sur deux jeux » à « 8 sur un seul jeu »). Un mouvement qui casserait
//      un minimum est refusé.

import { getGameType } from './gameTypes.js';

export const WEIGHTS = {
  replayGame: 400, // rejouer un jeu : 400 la 2e fois, 2000 la 3e…
  sameAsLast: 150, // même jeu qu'à l'étape précédente
  meetAgain: 12, // retrouver quelqu'un : 12 la 2e fois, 60 la 3e…
  pause: 2500, // être en pause : 2500 la 1re fois, 7500 en cumulé la 2e…
  underMin: 1e7, // (sécurité) table sous son minimum : ne doit jamais arriver
};

const PAUSE_ID = '__pause';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const F = (k) => (k <= 1 ? 0 : ((k - 1) * k * (2 * k - 1)) / 6); // 0, 0, 1, 5, 14…
const pauseCost = (k) => (WEIGHTS.pause * k * (k + 1)) / 2; // 0, 1, 3, 6… × poids

const playableOf = (games) => games.filter((g) => g.capacity > 0);
const minOf = (g) => Math.max(1, Math.min(g.minPlayers || 1, g.capacity));

// --- Formes valides --------------------------------------------------------------
// reach[i][s] : les jeux i..fin peuvent-ils accueillir exactement s joueurs ?
function buildReach(games, P) {
  const G = games.length;
  const reach = Array.from({ length: G + 1 }, () => new Uint8Array(P + 1));
  reach[G][0] = 1;
  for (let i = G - 1; i >= 0; i--) {
    const g = games[i];
    for (let s = 0; s <= P; s++) {
      if (reach[i + 1][s]) {
        reach[i][s] = 1;
        continue;
      }
      for (let v = minOf(g); v <= Math.min(g.capacity, s); v++)
        if (reach[i + 1][s - v]) {
          reach[i][s] = 1;
          break;
        }
    }
  }
  return reach;
}

// Nombre minimum de joueurs en pause à chaque étape (0 dans la plupart des cas).
export function minPauses(nbPlayers, games) {
  const playable = playableOf(games);
  if (!nbPlayers) return 0;
  const reach = buildReach(playable, nbPlayers);
  for (let s = nbPlayers; s >= 0; s--) if (reach[0][s]) return nbPlayers - s;
  return nbPlayers;
}

// Tire au hasard une forme valide : sizes[i] joueurs à la table i, total = target.
function sampleSizes(games, reach, target, rng) {
  const sizes = new Array(games.length).fill(0);
  let s = target;
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const opts = [];
    if (reach[i + 1][s]) opts.push(0);
    for (let v = minOf(g); v <= Math.min(g.capacity, s); v++) if (reach[i + 1][s - v]) opts.push(v);
    const v = opts[Math.floor(rng() * opts.length)];
    sizes[i] = v;
    s -= v;
  }
  return sizes;
}

// Nombre maximum de tables qui peuvent tourner en même temps en respectant les minimums.
function maxSimultaneousTables(P, games) {
  const target = P - minPauses(P, games);
  let best = new Array(target + 1).fill(-1); // best[s] = nb max de tables pour exactement s joueurs
  best[0] = 0;
  for (const g of games) {
    const next = [...best];
    for (let s = 0; s <= target; s++) {
      if (best[s] < 0) continue;
      for (let v = minOf(g); v <= g.capacity && s + v <= target; v++) next[s + v] = Math.max(next[s + v], best[s] + 1);
    }
    best = next;
  }
  return Math.max(1, best[target]);
}

// Combien d'étapes pour que chacun puisse passer sur tous les jeux ?
// Chaque jeu doit tourner assez de fois pour accueillir tout le monde, et seules
// quelques tables peuvent tourner en même temps quand les minimums sont élevés.
export function suggestedRoundCount(nbPlayers, games) {
  const playable = playableOf(games);
  if (!nbPlayers || !playable.length) return 0;
  let r = playable.length;
  let runs = 0;
  for (const g of playable) {
    const need = Math.ceil(nbPlayers / Math.min(g.capacity, nbPlayers));
    r = Math.max(r, need);
    runs += need;
  }
  const M = maxSimultaneousTables(nbPlayers, playable);
  if (M < playable.length) r = Math.max(r, Math.ceil(runs / M) + 1);
  return r;
}

function buildCounters(playerIds, history) {
  const playCount = {}; // playCount[p][gameId] (PAUSE_ID compte les pauses)
  const lastGame = {};
  const meet = {};
  for (const p of playerIds) playCount[p] = {};
  for (const round of history) {
    for (const table of round.tables) {
      const ids = table.playerIds;
      for (const p of ids) {
        playCount[p] ||= {};
        playCount[p][table.gameId] = (playCount[p][table.gameId] || 0) + 1;
        lastGame[p] = table.gameId;
      }
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const k = pairKey(ids[i], ids[j]);
          meet[k] = (meet[k] || 0) + 1;
        }
    }
    for (const p of round.paused || []) {
      playCount[p] ||= {};
      playCount[p][PAUSE_ID] = (playCount[p][PAUSE_ID] || 0) + 1;
      lastGame[p] = PAUSE_ID;
    }
  }
  return { playCount, lastGame, meet };
}

// Coût marginal d'ajouter p à une table pendant le remplissage glouton.
function addCost(game, members, p, counters) {
  const { playCount, lastGame, meet } = counters;
  const k = playCount[p]?.[game.id] || 0;
  if (game.id === PAUSE_ID) return pauseCost(k + 1) - pauseCost(k) + (lastGame[p] === PAUSE_ID ? WEIGHTS.sameAsLast : 0);
  let c = WEIGHTS.replayGame * (F(k + 1) - F(k));
  if (lastGame[p] === game.id) c += WEIGHTS.sameAsLast;
  for (const x of members) {
    const m = meet[pairKey(p, x)] || 0;
    c += WEIGHTS.meetAgain * (F(m + 1) - F(m));
  }
  return c;
}

// Remplit une forme donnée de façon gloutonne. Les équipes suivent leur membre quand c'est possible.
function fillSizes(playerIds, games, sizes, counters, rng) {
  const tables = games.map(() => []);
  const left = [...sizes];
  const placed = new Set();
  const order = [...playerIds].sort(() => rng() - 0.5);
  let cost = 0;
  for (const p of order) {
    if (placed.has(p)) continue;
    let bi = -1;
    let bd = Infinity;
    for (let g = 0; g < games.length; g++) {
      if (left[g] <= 0) continue;
      const d = addCost(games[g], tables[g], p, counters) + rng() * 0.01;
      if (d < bd) (bd = d), (bi = g);
    }
    const grp = (games[bi].groups || []).find((m) => m.includes(p));
    const mates = grp ? grp.filter((m) => m !== p && !placed.has(m) && playerIds.includes(m)) : [];
    const all = 1 + mates.length <= left[bi] ? [p, ...mates] : [p];
    for (const x of all) {
      cost += addCost(games[bi], tables[bi], x, counters);
      tables[bi].push(x);
      placed.add(x);
      left[bi]--;
    }
  }
  for (let g = 0; g < games.length; g++) {
    const gt = getGameType(games[g].type);
    if (tables[g].length && gt.tableCost) cost += gt.tableCost({ game: games[g], playerIds: tables[g] }) || 0;
  }
  return { tables, cost };
}

// Génère `count` nouvelles étapes à la suite de `history`.
// Renvoie un tableau d'étapes : { tables: [{ gameId, playerIds }], paused?: [playerId] }
export function generateRounds({ playerIds, games, history = [], count, seed = Date.now(), timeBudgetMs = 2500 }) {
  const real = playableOf(games);
  const P = playerIds.length;
  if (!P || !count) return [];
  const seats = real.reduce((s, g) => s + g.capacity, 0);
  if (seats < P) throw new Error(`Pas assez de places (${seats}) pour ${P} joueurs.`);

  const rng = mulberry32(seed);
  const reach = buildReach(real, P);
  const pauses = minPauses(P, real);
  const target = P - pauses;
  // la pause est une « table » virtuelle à la fin de la liste
  const all = [...real, { id: PAUSE_ID, capacity: P, minPlayers: 0, pause: true, type: 'standard' }];

  // 1) Solution de départ, étape par étape
  const hist = [...history];
  const fresh = [];
  const tries = Math.max(12, Math.min(60, 4 * real.length));
  for (let i = 0; i < count; i++) {
    const counters = buildCounters(playerIds, hist);
    let best = null;
    for (let t = 0; t < tries; t++) {
      const sizes = [...sampleSizes(real, reach, target, rng), pauses];
      const res = fillSizes(playerIds, all, sizes, counters, rng);
      if (!best || res.cost < best.cost) best = res;
    }
    fresh.push(best.tables);
    hist.push(toRound(all, best.tables));
  }

  // 2) Optimisation globale de toutes les nouvelles étapes (l'historique ne bouge pas)
  improveGlobally(playerIds, all, reach, target, history, fresh, rng, timeBudgetMs);

  return fresh.map((tables) => toRound(all, tables));
}

function toRound(all, tables) {
  const round = { tables: [] };
  all.forEach((g, gi) => {
    if (g.id === PAUSE_ID) {
      if (tables[gi].length) round.paused = [...tables[gi]];
    } else if (tables[gi].length) round.tables.push({ gameId: g.id, playerIds: [...tables[gi]] });
  });
  return round;
}

function improveGlobally(playerIds, games, reach, target, history, rounds, rng, timeBudgetMs) {
  const R = rounds.length;
  const G = games.length; // la dernière table est la pause
  const PI = G - 1;
  const real = games.slice(0, PI);
  if (R === 0 || playerIds.length < 2) return;

  const base = buildCounters(playerIds, history);
  const gIndex = Object.fromEntries(games.map((g, i) => [g.id, i]));
  const histLast = {};
  for (const p of playerIds) histLast[p] = base.lastGame[p] in gIndex ? gIndex[base.lastGame[p]] : -1;

  const pc = {}; // pc[p][gi]
  for (const p of playerIds) {
    pc[p] = new Array(G).fill(0);
    for (const [gid, k] of Object.entries(base.playCount[p] || {})) if (gid in gIndex) pc[p][gIndex[gid]] = k;
  }
  const meet = { ...base.meet };
  const pos = rounds.map(() => ({}));
  rounds.forEach((tables, r) =>
    tables.forEach((t, gi) => {
      for (const p of t) {
        pc[p][gi]++;
        pos[r][p] = gi;
      }
      if (gi === PI) return; // pas de rencontre en pause
      for (let i = 0; i < t.length; i++)
        for (let j = i + 1; j < t.length; j++) {
          const k = pairKey(t[i], t[j]);
          meet[k] = (meet[k] || 0) + 1;
        }
    })
  );

  const nbPause = playerIds.length - target; // toujours le minimum : on remplit un maximum de places
  const okSize = (gi, n) => (gi === PI ? n === nbPause : n === 0 || (n >= minOf(games[gi]) && n <= games[gi].capacity));
  const gameAt = (p, r) => (r < 0 ? histLast[p] : r >= R ? -2 : pos[r][p]);
  const termPlay = (p, g) => (g === PI ? pauseCost(pc[p][g]) : WEIGHTS.replayGame * F(pc[p][g]));
  const tableExtra = (gi, t) => {
    if (gi === PI || !t.length) return 0;
    const game = games[gi];
    let c = 0;
    if (!okSize(gi, t.length)) c += WEIGHTS.underMin;
    const gt = getGameType(game.type);
    if (gt.tableCost) c += gt.tableCost({ game, playerIds: t, playCount: {}, meet }) || 0;
    return c;
  };

  // Coût des termes touchés par un changement : ctxs = [[étape, tableA, tableB], …]
  function localCost(ctxs, movers) {
    let c = 0;
    const gs = new Set();
    const edges = new Set();
    const pairs = new Set();
    const tables = new Set();
    for (const [r, a, b] of ctxs) {
      gs.add(a).add(b);
      tables.add(r * G + a).add(r * G + b);
      for (const p of movers) {
        edges.add(p + '@' + (r - 1)).add(p + '@' + r);
        for (const z of rounds[r][a].concat(rounds[r][b])) if (z !== p) pairs.add(pairKey(p, z));
      }
    }
    for (const p of movers) for (const g of gs) c += termPlay(p, g);
    for (const e of edges) {
      const i = e.lastIndexOf('@');
      const p = e.slice(0, i);
      const r = Number(e.slice(i + 1));
      if (r + 1 >= R) continue;
      const g = gameAt(p, r);
      if (g >= 0 && g === gameAt(p, r + 1)) c += WEIGHTS.sameAsLast;
    }
    for (const k of pairs) c += WEIGHTS.meetAgain * F(meet[k] || 0);
    for (const t of tables) c += tableExtra(t % G, rounds[Math.floor(t / G)][t % G]);
    return c;
  }

  function move(r, p, from, to) {
    const tf = rounds[r][from];
    tf.splice(tf.indexOf(p), 1);
    if (from !== PI) for (const x of tf) meet[pairKey(p, x)]--;
    if (to !== PI) for (const y of rounds[r][to]) meet[pairKey(p, y)] = (meet[pairKey(p, y)] || 0) + 1;
    rounds[r][to].push(p);
    pc[p][from]--;
    pc[p][to]++;
    pos[r][p] = to;
  }

  function fullCost() {
    let c = 0;
    for (const p of playerIds) for (let g = 0; g < G; g++) c += termPlay(p, g);
    for (const p of playerIds)
      for (let r = -1; r + 1 < R; r++) {
        const g = gameAt(p, r);
        if (g >= 0 && g === gameAt(p, r + 1)) c += WEIGHTS.sameAsLast;
      }
    for (const k in meet) c += WEIGHTS.meetAgain * F(meet[k]);
    for (let r = 0; r < R; r++) for (let g = 0; g < G; g++) c += tableExtra(g, rounds[r][g]);
    return c;
  }

  let total = fullCost();
  let bestTotal = total;
  let best = rounds.map((t) => t.map((x) => [...x]));
  const keepIfBest = () => {
    if (total < bestTotal - 1e-9) {
      bestTotal = total;
      best = rounds.map((t) => t.map((x) => [...x]));
    }
  };

  // Applique une liste de déplacements dans l'étape r, puis accepte ou annule.
  // Toute forme invalide (table sous son minimum ou au-dessus de son maximum) est annulée.
  function tryOps(r, ops, T) {
    if (!ops.length) return;
    const ctxs = ops.map(([, from, to]) => [r, from, to]);
    const movers = [...new Set(ops.map(([p]) => p))];
    const before = localCost(ctxs, movers);
    for (const [p, from, to] of ops) move(r, p, from, to);
    const touched = new Set(ops.flatMap(([, a, b]) => [a, b]));
    let valid = true;
    for (const gi of touched) if (!okSize(gi, rounds[r][gi].length)) valid = false;
    const delta = valid ? localCost(ctxs, movers) - before : Infinity;
    if (!valid || (delta > 0 && rng() >= Math.exp(-delta / T))) {
      for (let i = ops.length - 1; i >= 0; i--) move(r, ops[i][0], ops[i][2], ops[i][1]);
    } else {
      total += delta;
      keepIfBest();
    }
  }

  const known = new Set(playerIds);
  const groupsList = [];
  games.forEach((g, gi) =>
    (g.groups || []).forEach((members) => {
      const m = members.filter((p) => known.has(p));
      if (m.length > 1) groupsList.push({ gi, members: m });
    })
  );

  const deadline = Date.now() + timeBudgetMs;
  const itPerCycle = 20000 + 300 * R * playerIds.length;
  const T0 = 40;
  const cooling = Math.pow(0.1 / T0, 1 / itPerCycle);
  let T = T0;
  for (let it = 0; ; it++) {
    if ((it & 1023) === 0 && Date.now() > deadline) break;
    if (it % itPerCycle === 0) {
      if (it >= itPerCycle * 6) break;
      T = T0;
    }
    T *= cooling;
    const roll = rng();
    const r = Math.floor(rng() * R);

    // Changement de forme : nouvelle répartition des tailles de tables pour l'étape r.
    // Les joueurs restent à leur table quand c'est possible ; les autres sont redistribués.
    // La température est montée pour laisser le temps aux échanges suivants d'en tirer parti.
    if (roll < 0.04) {
      const sizes = [...sampleSizes(real, reach, target, rng), nbPause];
      const pool = [];
      const ops = [];
      const cur = rounds[r].map((t) => [...t]);
      cur.forEach((t, gi) => {
        const extra = t.length - sizes[gi];
        for (let i = 0; i < extra; i++) pool.push([t.splice(Math.floor(rng() * t.length), 1)[0], gi]);
      });
      pool.sort(() => rng() - 0.5);
      cur.forEach((t, gi) => {
        for (let i = t.length; i < sizes[gi]; i++) {
          const [p, from] = pool.pop();
          ops.push([p, from, gi]);
        }
      });
      tryOps(r, ops, T * 4);
      continue;
    }

    // Déplacement d'équipe : toute l'équipe rejoint une même table.
    if (groupsList.length && roll < 0.3) {
      const grp = groupsList[Math.floor(rng() * groupsList.length)];
      const t = rng() < 0.5 ? grp.gi : Math.floor(rng() * (G - 1));
      const members = grp.members.filter((m) => pos[r][m] !== t);
      if (!members.length) continue;
      const inGroup = new Set(grp.members);
      const candidates = rounds[r][t].filter((x) => !inGroup.has(x));
      const ops = [];
      for (const m of members) {
        const from = pos[r][m];
        ops.push([m, from, t]);
        if (candidates.length) {
          const q = candidates.splice(Math.floor(rng() * candidates.length), 1)[0];
          ops.push([q, t, from]);
        }
      }
      tryOps(r, ops, T);
      continue;
    }

    const a = Math.floor(rng() * G);
    const b = Math.floor(rng() * G);
    if (a === b || !rounds[r][a].length) continue;
    const p = rounds[r][a][Math.floor(rng() * rounds[r][a].length)];

    // Échange croisé : p et q échangent leurs places à deux étapes différentes,
    // donc chacun garde les mêmes jeux ; seules les rencontres changent.
    if (rounds[r][b].length && R > 1 && roll < 0.6) {
      const q = rounds[r][b][Math.floor(rng() * rounds[r][b].length)];
      const start = Math.floor(rng() * R);
      for (let i = 0; i < R; i++) {
        const x = (start + i) % R;
        if (x !== r && pos[x][p] === b && pos[x][q] === a) {
          const ctxs = [[r, a, b], [x, a, b]];
          const before = localCost(ctxs, [p, q]);
          move(r, p, a, b), move(r, q, b, a), move(x, p, b, a), move(x, q, a, b);
          const delta = localCost(ctxs, [p, q]) - before;
          if (delta > 0 && rng() >= Math.exp(-delta / T)) {
            move(x, q, b, a), move(x, p, a, b), move(r, q, a, b), move(r, p, b, a);
          } else {
            total += delta;
            keepIfBest();
          }
          break;
        }
      }
      continue;
    }

    // Échange simple, ou déplacement si les tailles restent valides
    const q = rounds[r][b].length && rng() < 0.7 ? rounds[r][b][Math.floor(rng() * rounds[r][b].length)] : null;
    tryOps(r, q ? [[p, a, b], [q, b, a]] : [[p, a, b]], T);
  }
  best.forEach((t, r) => (rounds[r] = t));
}

// Statistiques utiles pour l'admin et les tests.
export function scheduleStats(playerIds, games, rounds) {
  const { playCount, meet } = buildCounters(playerIds, rounds);
  const playable = playableOf(games);
  const missing = {};
  for (const p of playerIds) {
    const m = playable.filter((g) => !playCount[p]?.[g.id]).map((g) => g.id);
    if (m.length) missing[p] = m;
  }
  const meets = Object.values(meet);
  const underMin = rounds
    .flatMap((r) => r.tables)
    .filter((t) => {
      const g = games.find((x) => x.id === t.gameId);
      return t.playerIds.length < minOf(g) || t.playerIds.length > g.capacity;
    }).length;
  return {
    maxMeet: meets.length ? Math.max(...meets) : 0,
    repeatedPairs: meets.filter((m) => m > 1).length,
    pauses: rounds.reduce((n, r) => n + (r.paused?.length || 0), 0),
    underMin,
    missing,
  };
}
