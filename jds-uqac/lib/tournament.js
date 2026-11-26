// Logique du tournoi : état, actions joueurs et actions admin.
import { randomUUID } from 'node:crypto';
import { generateRounds, suggestedRoundCount, minPauses } from './scheduler.js';
import { getGameType, listGameTypes } from './gameTypes.js';

export function initialState() {
  return {
    status: 'registration', // 'registration' | 'running' | 'finished'
    registrationOpen: true,
    games: [], // { id, name, description, capacity, minPlayers, type, config, deleted? }
    players: [], // { id, pseudo, token, joinedAt, removed? }
    rounds: [], // { tables: [{ gameId, playerIds, sides? }] } — planning calculé par l'algo
    currentRound: -1,
    scores: {}, // scores[indexÉtape][playerId] = points
    scoreBy: {}, // scoreBy[indexÉtape][playerId] = 'player' | 'admin' | 'auto' : qui a saisi ces points
    adjustments: {}, // adjustments[playerId] = points ajoutés/retirés par les admins hors étape (bonus/malus)
    gameData: {}, // gameData[gameId] = données propres au jeu, ex. { teams: [[pid, pid], …] }
    tableData: {}, // tableData["étape:gameId"] = { players: { pid: { role } }, table: { winner } }
    updatedAt: Date.now(),
  };
}

export class UserError extends Error {}
const fail = (msg) => {
  throw new UserError(msg);
};

const activePlayers = (s) => s.players.filter((p) => !p.removed);
const activeGames = (s) => s.games.filter((g) => !g.deleted);
const seats = (s) => activeGames(s).reduce((n, g) => n + g.capacity, 0);
const pseudoOf = (s, id) => s.players.find((p) => p.id === id)?.pseudo ?? '?';
const tableKey = (round, gameId) => `${round}:${gameId}`;

function migrate(s) {
  s.scoreBy ||= {};
  s.adjustments ||= {};
  if (s.autoScored) {
    // ancien format
    for (const [r, m] of Object.entries(s.autoScored)) for (const pid of Object.keys(m)) ((s.scoreBy[r] ||= {})[pid] = 'auto');
    delete s.autoScored;
  }
  s.gameData ||= {};
  s.tableData ||= {};
}

function cleanPseudo(raw) {
  const p = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!p) fail('Choisis un pseudo.');
  if (p.length > 20) fail('Pseudo trop long (20 caractères max).');
  return p;
}

function cleanGame(input, existing = {}) {
  const type = String(existing.type ?? input.type ?? 'standard'); // le type ne change pas après création
  const gt = getGameType(type);
  const name = String(input.name ?? existing.name ?? '').trim();
  if (!name) fail('Le jeu doit avoir un nom.');
  if (name.length > 60) fail('Nom de jeu trop long.');
  const capacity = Math.floor(Number(input.capacity ?? existing.capacity));
  if (!Number.isFinite(capacity) || capacity < 1 || capacity > 100) fail('Nombre de places invalide (1 à 100).');
  if (capacity < (gt.minCapacity || 1)) fail(`${gt.label} demande au moins ${gt.minCapacity} places.`);
  const minPlayers = Math.floor(Number(input.minPlayers ?? existing.minPlayers ?? 1));
  if (!Number.isFinite(minPlayers) || minPlayers < 1) fail('Minimum de joueurs invalide.');
  if (minPlayers > capacity) fail('Le minimum de joueurs dépasse le nombre de places.');
  return {
    name,
    description: String(input.description ?? existing.description ?? '').trim().slice(0, 300),
    capacity,
    minPlayers,
    type: gt.id,
    config: gt.normalizeConfig({ ...(existing.config || {}), ...(input.config || {}) }),
  };
}

// --- Équipes (jeux de type « teams », ex. Codenames) ---------------------------
function teamsOf(s, game) {
  if (!getGameType(game.type).teams) return [];
  const active = new Set(activePlayers(s).map((p) => p.id));
  return (s.gameData[game.id]?.teams || []).map((t) => t.filter((p) => active.has(p))).filter((t) => t.length > 1);
}
function cleanTeams(s, gameId) {
  const d = s.gameData[gameId];
  if (!d?.teams) return;
  const active = new Set(activePlayers(s).map((p) => p.id));
  d.teams = d.teams.map((t) => t.filter((p) => active.has(p))).filter((t) => t.length > 1);
}
function removeFromAllTeams(s, playerId) {
  for (const gid of Object.keys(s.gameData)) {
    const d = s.gameData[gid];
    if (!d?.teams) continue;
    d.teams = d.teams.map((t) => t.filter((p) => p !== playerId)).filter((t) => t.length > 1);
  }
}
function checkTeams(s) {
  for (const g of activeGames(s)) {
    const gt = getGameType(g.type);
    if (!gt.teams) continue;
    const max = gt.teams.maxSize(g);
    for (const t of teamsOf(s, g))
      if (t.length > max)
        fail(`L'équipe ${t.map((p) => pseudoOf(s, p)).join(', ')} est trop grande pour ${g.name} (${max} max). Retire quelqu'un ou augmente les places.`);
  }
}

// --- Planification -------------------------------------------------------------
function algoGames(s) {
  return activeGames(s).map((g) => ({ ...g, groups: teamsOf(s, g) }));
}
function plan(s, history, count) {
  const games = algoGames(s);
  const rounds = generateRounds({ playerIds: activePlayers(s).map((p) => p.id), games, history, count });
  for (const r of rounds)
    for (const t of r.tables) {
      const g = games.find((x) => x.id === t.gameId);
      getGameType(g.type).decorateTable?.(t, g);
    }
  return rounds;
}

// Recalcule les étapes futures (après l'étape en cours), en gardant l'historique.
function replanFuture(s) {
  if (s.status === 'registration') return;
  const n = activePlayers(s).length;
  if (n > seats(s)) fail(`Pas assez de places (${seats(s)}) pour ${n} joueurs.`);
  checkTeams(s);
  const keep = s.rounds.slice(0, s.currentRound + 1);
  const remaining = Math.max(s.rounds.length - keep.length, suggestedRoundCount(n, activeGames(s)));
  s.rounds = keep.concat(plan(s, keep, remaining));
}

function ensureFutureRounds(s, upTo) {
  if (upTo < s.rounds.length) return;
  const extra = Math.max(upTo - s.rounds.length + 1, suggestedRoundCount(activePlayers(s).length, activeGames(s)), 3);
  s.rounds = s.rounds.concat(plan(s, s.rounds, extra));
}

// --- Points automatiques (fin d'étape) -----------------------------------------
function applyAutoScores(s, round) {
  const warnings = [];
  let applied = 0;
  for (const t of s.rounds[round]?.tables || []) {
    const game = s.games.find((g) => g.id === t.gameId);
    const gt = getGameType(game?.type);
    if (!gt.scoreTable) continue;
    const data = s.tableData[tableKey(round, t.gameId)] || {};
    const { scores, missing = [], needs } = gt.scoreTable({ game, table: t, data });
    if (needs) warnings.push(`${game.name} : ${needs} n'a pas été indiqué, aucun point attribué.`);
    else if (missing.length) warnings.push(`${game.name} : rôle manquant pour ${missing.map((p) => pseudoOf(s, p)).join(', ')}.`);
    s.scores[round] ||= {};
    s.scoreBy[round] ||= {};
    for (const [pid, pts] of Object.entries(scores)) {
      const manual = s.scores[round][pid] !== undefined && s.scoreBy[round][pid] !== 'auto';
      if (manual) continue; // une saisie manuelle n'est jamais écrasée
      s.scores[round][pid] = pts;
      s.scoreBy[round][pid] = 'auto';
      applied++;
    }
  }
  return { applied, warnings };
}

// --- Choix déclarés à la table (ex. rôle Secret Hitler) ------------------------
function setChoice(s, round, gameId, playerId, key, value, { asAdmin = false } = {}) {
  const table = s.rounds[round]?.tables.find((t) => t.gameId === gameId);
  if (!table) fail('Table introuvable.');
  const game = s.games.find((g) => g.id === gameId);
  const schema = getGameType(game.type).choices?.(game)?.[key];
  if (!schema) fail('Choix inconnu pour ce jeu.');
  if (value !== null && !schema.options.some((o) => o.value === value)) fail('Valeur invalide.');
  const k = tableKey(round, gameId);
  s.tableData[k] ||= { players: {}, table: {} };
  const d = s.tableData[k];
  if (schema.scope === 'table') {
    if (value === null) delete d.table[key];
    else d.table[key] = value;
  } else {
    if (!table.playerIds.includes(playerId)) fail(asAdmin ? "Ce joueur n'est pas à cette table." : "Tu n'es pas à cette table.");
    d.players[playerId] ||= {};
    if (value === null) delete d.players[playerId][key];
    else d.players[playerId][key] = value;
  }
}

function playerByToken(s, token) {
  const p = s.players.find((p) => p.token === token && !p.removed);
  if (!p) fail("Tu n'es pas inscrit·e (ou tu as été retiré·e).");
  return p;
}

// ----------------------------------------------------------------------------
// Actions. `admin: true` => mot de passe admin requis.
// Chaque action reçoit (state, params) et modifie state en place.
export const ACTIONS = {
  // --- Joueurs -------------------------------------------------------------
  register: {
    run(s, { pseudo }) {
      const name = cleanPseudo(pseudo);
      if (s.status === 'finished') fail('Le tournoi est terminé.');
      if (!s.registrationOpen) fail('Les inscriptions sont fermées.');
      if (activePlayers(s).some((p) => p.pseudo.toLowerCase() === name.toLowerCase())) fail('Ce pseudo est déjà pris.');
      if (activePlayers(s).length >= seats(s))
        fail(seats(s) === 0 ? "Aucun jeu n'est encore ouvert." : 'Plus de place : le tournoi est complet.');
      const player = { id: randomUUID().slice(0, 8), pseudo: name, token: randomUUID(), joinedAt: Date.now() };
      s.players.push(player);
      replanFuture(s); // inscription tardive (si l'admin a rouvert) : on replanifie la suite
      return { id: player.id, pseudo: player.pseudo, token: player.token };
    },
  },
  leave: {
    run(s, { token }) {
      const p = s.players.find((p) => p.token === token && !p.removed);
      if (!p) return { ok: true };
      if (s.status !== 'registration') fail('Le tournoi a commencé : demande à un admin de te retirer.');
      removeFromAllTeams(s, p.id);
      s.players = s.players.filter((x) => x !== p);
      return { ok: true };
    },
  },
  whoami: {
    readOnly: true,
    run(s, { token }) {
      const p = s.players.find((p) => p.token === token && !p.removed);
      if (!p) return null;
      // mes choix secrets de l'étape en cours (cachés dans l'état public)
      const myChoices = {};
      for (const t of s.rounds[s.currentRound]?.tables || []) {
        const d = s.tableData[tableKey(s.currentRound, t.gameId)];
        if (d?.players?.[p.id]) myChoices[t.gameId] = d.players[p.id];
      }
      return { id: p.id, pseudo: p.pseudo, myChoices };
    },
  },
  joinTeam: {
    run(s, { token, gameId, withPlayerId }) {
      const me = playerByToken(s, token);
      if (s.status !== 'registration') fail('Les équipes sont verrouillées depuis le début du tournoi.');
      const game = activeGames(s).find((g) => g.id === gameId);
      const gt = getGameType(game?.type);
      if (!game || !gt.teams) fail("Ce jeu n'a pas d'équipes.");
      const other = activePlayers(s).find((p) => p.id === withPlayerId);
      if (!other || other.id === me.id) fail('Joueur introuvable.');
      const max = gt.teams.maxSize(game);
      s.gameData[gameId] ||= {};
      const d = s.gameData[gameId];
      d.teams ||= [];
      let team = d.teams.find((t) => t.includes(other.id));
      if (team?.includes(me.id)) return { ok: true };
      if (team && team.length >= max) fail(`L'équipe de ${other.pseudo} est complète (${max} max).`);
      d.teams = d.teams.map((t) => t.filter((p) => p !== me.id)); // je quitte mon équipe actuelle
      team = d.teams.find((t) => t.includes(other.id));
      if (team) team.push(me.id);
      else d.teams.push([other.id, me.id]);
      cleanTeams(s, gameId);
      return { ok: true };
    },
  },
  leaveTeam: {
    run(s, { token, gameId }) {
      const me = playerByToken(s, token);
      if (s.status !== 'registration') fail('Les équipes sont verrouillées depuis le début du tournoi.');
      const d = s.gameData[gameId];
      if (d?.teams) d.teams = d.teams.map((t) => t.filter((p) => p !== me.id));
      cleanTeams(s, gameId);
      return { ok: true };
    },
  },
  setMyScore: {
    run(s, { token, points }) {
      const me = playerByToken(s, token);
      if (s.status !== 'running') fail("Le tournoi n'est pas en cours.");
      const t = s.rounds[s.currentRound]?.tables.find((t) => t.playerIds.includes(me.id));
      if (!t) fail("Tu n'as pas de table à cette étape.");
      const game = s.games.find((g) => g.id === t.gameId);
      if (getGameType(game.type).scoreTable) fail(`Les points de ${game.name} sont calculés automatiquement.`);
      writeScore(s, s.currentRound, me.id, points, 'player');
      return { round: s.currentRound, points: s.scores[s.currentRound]?.[me.id] ?? null };
    },
  },
  tableChoice: {
    run(s, { token, gameId, key, value }) {
      const me = playerByToken(s, token);
      if (s.status !== 'running') fail("Le tournoi n'est pas en cours.");
      setChoice(s, s.currentRound, gameId, me.id, key, value ?? null);
      return { ok: true };
    },
  },

  // --- Admin : jeux ---------------------------------------------------------
  adminCheck: { admin: true, readOnly: true, run: () => ({ ok: true }) },

  createGame: {
    admin: true,
    run(s, { game }) {
      const g = { id: randomUUID().slice(0, 8), ...cleanGame(game || {}) };
      s.games.push(g);
      replanFuture(s);
      return g;
    },
  },
  updateGame: {
    admin: true,
    run(s, { id, game }) {
      const g = s.games.find((g) => g.id === id && !g.deleted);
      if (!g) fail('Jeu introuvable.');
      const before = JSON.stringify([g.capacity, g.minPlayers]);
      Object.assign(g, cleanGame(game || {}, g));
      if (before !== JSON.stringify([g.capacity, g.minPlayers])) replanFuture(s);
      return g;
    },
  },
  deleteGame: {
    admin: true,
    run(s, { id }) {
      const g = s.games.find((g) => g.id === id && !g.deleted);
      if (!g) fail('Jeu introuvable.');
      const played = s.rounds.slice(0, s.currentRound + 1).some((r) => r.tables.some((t) => t.gameId === id));
      if (played) g.deleted = true; // on garde son nom pour l'historique
      else s.games = s.games.filter((x) => x !== g);
      try {
        replanFuture(s);
      } catch (e) {
        if (played) delete g.deleted;
        else s.games.push(g);
        throw e;
      }
      if (!played) delete s.gameData[id];
      return { ok: true };
    },
  },

  // --- Admin : joueurs et équipes ------------------------------------------
  removePlayer: {
    admin: true,
    run(s, { id }) {
      const p = s.players.find((p) => p.id === id && !p.removed);
      if (!p) fail('Joueur introuvable.');
      removeFromAllTeams(s, p.id);
      if (s.status === 'registration') s.players = s.players.filter((x) => x !== p);
      else {
        p.removed = true;
        replanFuture(s);
      }
      return { ok: true };
    },
  },
  adminRemoveFromTeam: {
    admin: true,
    run(s, { gameId, playerId }) {
      const d = s.gameData[gameId];
      if (d?.teams) d.teams = d.teams.map((t) => t.filter((p) => p !== playerId));
      cleanTeams(s, gameId);
      replanFuture(s);
      return { ok: true };
    },
  },
  setRegistration: {
    admin: true,
    run(s, { open }) {
      s.registrationOpen = !!open;
      return { ok: true };
    },
  },

  // --- Admin : déroulement --------------------------------------------------
  start: {
    admin: true,
    run(s) {
      if (s.status !== 'registration') fail('Le tournoi a déjà commencé.');
      const players = activePlayers(s);
      const games = activeGames(s);
      if (players.length < 2) fail('Il faut au moins 2 joueurs.');
      if (!games.length) fail('Ajoute au moins un jeu.');
      if (players.length > seats(s)) fail(`Pas assez de places (${seats(s)}) pour ${players.length} joueurs.`);
      checkTeams(s);
      const pauses = minPauses(players.length, games);
      if (pauses === players.length)
        fail(`Avec ${players.length} joueurs, aucun jeu ne peut atteindre son minimum de joueurs.`);
      // L'algo tourne une fois ici et fixe l'ordre des jeux de chaque joueur.
      const count = Math.max(suggestedRoundCount(players.length, games), 3);
      s.rounds = plan(s, [], count);
      s.currentRound = 0;
      s.status = 'running';
      s.registrationOpen = false;
      s.scores = {};
      s.scoreBy = {};
      s.adjustments = {};
      s.tableData = {};
      return {
        warnings: pauses
          ? [`Avec ${players.length} joueurs et ces minimums, ${pauses} joueur${pauses > 1 ? 's seront' : ' sera'} en pause à chaque étape (à tour de rôle).`]
          : [],
      };
    },
  },
  next: {
    admin: true,
    run(s) {
      if (s.status !== 'running') fail("Le tournoi n'est pas en cours.");
      const auto = applyAutoScores(s, s.currentRound);
      ensureFutureRounds(s, s.currentRound + 1);
      s.currentRound++;
      return auto;
    },
  },
  prev: {
    admin: true,
    run(s) {
      if (s.status === 'finished') {
        s.status = 'running';
        return { ok: true };
      }
      if (s.status !== 'running') fail("Le tournoi n'est pas en cours.");
      if (s.currentRound <= 0) fail('Déjà à la première étape.');
      s.currentRound--;
      return { ok: true };
    },
  },
  finish: {
    admin: true,
    run(s) {
      if (s.status !== 'running') fail("Le tournoi n'est pas en cours.");
      const auto = applyAutoScores(s, s.currentRound);
      s.status = 'finished';
      s.registrationOpen = false;
      return auto;
    },
  },
  replan: {
    admin: true,
    run(s) {
      if (s.status === 'registration') fail("Le tournoi n'a pas commencé.");
      replanFuture(s);
      return { ok: true };
    },
  },
  setScore: {
    admin: true,
    run(s, { round, playerId, points }) {
      const r = checkScoreTarget(s, round, playerId);
      writeScore(s, r, playerId, points, 'admin');
      return { ok: true };
    },
  },
  addScore: {
    admin: true,
    run(s, { round, playerId, delta }) {
      const r = checkScoreTarget(s, round, playerId);
      const d = Number(delta);
      if (!Number.isFinite(d)) fail('Points invalides.');
      writeScore(s, r, playerId, (s.scores[r]?.[playerId] || 0) + d, 'admin');
      return { points: s.scores[r][playerId] };
    },
  },
  adjustPlayer: {
    admin: true,
    run(s, { playerId, delta }) {
      if (!s.players.some((p) => p.id === playerId && !p.removed)) fail('Joueur introuvable.');
      const d = Number(delta);
      if (!Number.isFinite(d) || d === 0) fail('Montant invalide.');
      s.adjustments[playerId] = Math.round(((s.adjustments[playerId] || 0) + d) * 100) / 100;
      return { adjustment: s.adjustments[playerId] };
    },
  },
  adminTableChoice: {
    admin: true,
    run(s, { round, gameId, playerId, key, value }) {
      const r = Math.floor(Number(round));
      if (!(r >= 0 && r <= s.currentRound)) fail('Étape invalide.');
      setChoice(s, r, gameId, playerId, key, value ?? null, { asAdmin: true });
      // si l'étape est déjà passée, on recalcule ses points automatiques
      if (r < s.currentRound || s.status === 'finished') return applyAutoScores(s, r);
      return { ok: true };
    },
  },
  resetTournament: {
    admin: true,
    run(s, { keepPlayers = true }) {
      const fresh = initialState();
      fresh.games = activeGames(s);
      if (keepPlayers) {
        fresh.players = activePlayers(s);
        fresh.gameData = s.gameData;
      }
      Object.keys(s).forEach((k) => delete s[k]);
      Object.assign(s, fresh);
      return { ok: true };
    },
  },
};

function writeScore(s, r, playerId, points, by) {
  s.scores[r] ||= {};
  s.scoreBy[r] ||= {};
  if (points === null || points === '' || points === undefined) {
    delete s.scores[r][playerId];
    delete s.scoreBy[r][playerId];
    return;
  }
  const v = Number(points);
  if (!Number.isFinite(v) || Math.abs(v) > 100000) fail('Points invalides.');
  s.scores[r][playerId] = Math.round(v * 100) / 100;
  s.scoreBy[r][playerId] = by;
}

function checkScoreTarget(s, round, playerId) {
  const r = Math.floor(Number(round));
  if (!(r >= 0 && r < s.rounds.length)) fail('Étape invalide.');
  if (!s.players.some((p) => p.id === playerId)) fail('Joueur introuvable.');
  return r;
}

// Toutes les actions passent par ici pour mettre à niveau un ancien état.
for (const a of Object.values(ACTIONS)) {
  const run = a.run;
  a.run = (s, params) => (migrate(s), run(s, params || {}));
}

// Vue envoyée au navigateur. Sans `admin`, on retire les tokens et on cache les
// choix secrets (ex. rôles Secret Hitler) de l'étape en cours.
export function publicState(s, version, { admin = false } = {}) {
  migrate(s);
  const totals = {};
  for (const p of s.players) totals[p.id] = 0;
  for (const r of Object.values(s.scores))
    for (const [pid, pts] of Object.entries(r)) totals[pid] = (totals[pid] || 0) + pts;
  for (const [pid, adj] of Object.entries(s.adjustments)) totals[pid] = (totals[pid] || 0) + adj;
  const players = s.players.map(({ id, pseudo, joinedAt, removed }) => ({
    id,
    pseudo,
    joinedAt,
    removed: !!removed,
    adjustment: s.adjustments[id] || 0,
    total: Math.round((totals[id] || 0) * 100) / 100,
  }));
  const ranking = players
    .filter((p) => !p.removed)
    .sort((a, b) => b.total - a.total || a.pseudo.localeCompare(b.pseudo))
    .map((p) => ({ ...p }));
  ranking.forEach((p, i) => (p.rank = i > 0 && ranking[i - 1].total === p.total ? ranking[i - 1].rank : i + 1));

  const tableData = {};
  for (const [k, d] of Object.entries(s.tableData)) {
    const [round, gameId] = k.split(':');
    const game = s.games.find((g) => g.id === gameId);
    const schema = game ? getGameType(game.type).choices?.(game) || {} : {};
    const hide = !admin && s.status === 'running' && Number(round) === s.currentRound;
    const players = {};
    for (const [pid, ch] of Object.entries(d.players || {})) {
      players[pid] = {};
      for (const [key, v] of Object.entries(ch)) players[pid][key] = hide && schema[key]?.secret ? 'déclaré' : v;
    }
    tableData[k] = { players, table: d.table || {} };
  }

  const games = s.games.map((g) => {
    const gt = getGameType(g.type);
    return {
      ...g,
      choices: gt.choices?.(g) || null,
      autoScore: !!gt.scoreTable,
      ...(gt.teams ? { teams: teamsOf(s, g), maxTeamSize: gt.teams.maxSize(g) } : {}),
    };
  });

  return {
    version,
    status: s.status,
    registrationOpen: s.registrationOpen,
    games,
    players,
    ranking,
    rounds: s.rounds,
    currentRound: s.currentRound,
    scores: s.scores,
    scoreBy: s.scoreBy,
    tableData,
    seats: seats(s),
    activePlayers: activePlayers(s).length,
    pausesPerRound: minPauses(activePlayers(s).length, activeGames(s)),
    gameTypes: listGameTypes(),
  };
}
