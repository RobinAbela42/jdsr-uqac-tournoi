// Bibliothèque des types de jeux.
//
// Chaque jeu du tournoi a un `type`. Un type peut fournir les hooks suivants
// (tous facultatifs sauf id/label) :
//
//   preset            valeurs proposées quand on ajoute le jeu depuis la bibliothèque
//   minCapacity       nombre de places minimum accepté
//   configFields      réglages affichés dans l'admin : [{ key, label, kind: 'number'|'boolean', hint?, showIf? }]
//   normalizeConfig   nettoie la config saisie par l'admin
//   teams             { maxSize(game) } : les joueurs forment des équipes avant le tournoi,
//                     qui jouent toujours ensemble à ce jeu (l'algo reçoit game.groups)
//   tableCost         pénalité ajoutée au coût de l'algo pour une table ({ game, playerIds })
//   decorateTable     ajoute des infos à une table une fois le planning calculé (ex. les camps)
//   choices           ce que les joueurs déclarent à la table pendant l'étape (ex. leur rôle)
//   scoreTable        calcule les points d'une table à la fin de l'étape (à partir des choix)
//
// Pour ajouter un jeu spécial : écrire un objet avec ces hooks et l'ajouter à GAME_TYPES.

// ---------------------------------------------------------------------------- Standard
const standard = {
  id: 'standard',
  label: 'Jeu personnalisé',
  description: 'Un jeu classique : chacun pour soi, les points sont saisis par les admins.',
  special: false,
  configFields: [],
  normalizeConfig: () => ({}),
};

// ---------------------------------------------------------------------------- Codenames
// Répartit les joueurs d'une table en deux camps en gardant chaque équipe ensemble
// et en équilibrant le nombre de joueurs. Renvoie aussi l'écart de taille.
export function splitSides(playerIds, groups = []) {
  const present = new Set(playerIds);
  const used = new Set();
  const units = [];
  for (const g of groups) {
    const inside = g.filter((p) => present.has(p));
    if (inside.length === g.length && inside.length > 1) {
      units.push({ ids: inside, team: true });
      inside.forEach((p) => used.add(p));
    }
  }
  for (const p of playerIds) if (!used.has(p)) units.push({ ids: [p], team: false });
  units.sort((a, b) => b.ids.length - a.ids.length);

  // Recherche exhaustive (au plus ~12 unités) : écart minimal, puis équipes réparties
  // des deux côtés plutôt qu'une équipe contre des joueurs seuls.
  const n = units.length;
  if (n > 14) {
    // grande table : glouton (plus grosse unité vers le camp le plus petit)
    const sides = [[], []];
    for (const u of units) sides[sides[0].length <= sides[1].length ? 0 : 1].push(...u.ids);
    return { sides, diff: Math.abs(sides[0].length - sides[1].length) };
  }
  let best = null;
  const limit = n ? 1 << (n - 1) : 1; // le 1er élément est fixé côté A (symétrie)
  for (let mask = 0; mask < limit; mask++) {
    let a = 0, b = 0, ta = 0, tb = 0;
    for (let i = 0; i < n; i++) {
      const inB = i > 0 && mask & (1 << (i - 1));
      const s = units[i].ids.length;
      if (inB) (b += s), (tb += units[i].team ? s : 0);
      else (a += s), (ta += units[i].team ? s : 0);
    }
    const score = Math.abs(a - b) * 100 + Math.abs(ta - tb);
    if (!best || score < best.score) best = { score, mask, diff: Math.abs(a - b) };
  }
  const sides = [[], []];
  units.forEach((u, i) => sides[i > 0 && best.mask & (1 << (i - 1)) ? 1 : 0].push(...u.ids));
  return { sides, diff: best.diff };
}

const codenames = {
  id: 'codenames',
  label: 'Codenames',
  special: true,
  description:
    "Les joueurs peuvent former leur équipe à l'avance (jusqu'à la moitié des places). Une équipe joue toujours ensemble, contre un camp de même taille.",
  preset: { name: 'Codenames', capacity: 6, minPlayers: 4, description: '' },
  minCapacity: 4,
  configFields: [],
  normalizeConfig: () => ({}),
  teams: { maxSize: (game) => Math.floor(game.capacity / 2) },
  tableCost({ game, playerIds }) {
    const groups = game.groups || [];
    if (!playerIds.length) return 0;
    let cost = 0;
    const here = new Set(playerIds);
    for (const g of groups) {
      const inside = g.filter((p) => here.has(p)).length;
      if (inside > 0 && inside < g.length) cost += 4000 * Math.min(inside, g.length - inside); // équipe coupée
    }
    const { diff } = splitSides(playerIds, groups);
    if (diff > 1) cost += 600 * (diff - 1); // camps déséquilibrés
    return cost;
  },
  decorateTable(table, game) {
    table.sides = splitSides(table.playerIds, game.groups || []).sides;
  },
};

// ---------------------------------------------------------------------------- Secret Hitler
const ROLES = [
  { value: 'liberal', label: 'Libéral' },
  { value: 'fasciste', label: 'Fasciste' },
  { value: 'hitler', label: 'Hitler' },
];
const CAMP = { liberal: 'liberal', fasciste: 'fasciste', hitler: 'fasciste' };

const secretHitler = {
  id: 'secret-hitler',
  label: 'Secret Hitler',
  special: true,
  description:
    "À la fin de la partie, chaque joueur indique son rôle (libéral, fasciste ou Hitler) et la table indique le camp gagnant. Les points sont attribués automatiquement au passage à l'étape suivante.",
  preset: { name: 'Secret Hitler', capacity: 10, minPlayers: 5, description: '' },
  minCapacity: 5,
  configFields: [
    { key: 'countsResult', label: 'Les points dépendent du camp gagnant', kind: 'boolean' },
    { key: 'liberal', label: 'Libéral', kind: 'number', hint: 'si son camp gagne' },
    { key: 'fasciste', label: 'Fasciste', kind: 'number', hint: 'si son camp gagne' },
    { key: 'hitler', label: 'Hitler', kind: 'number', hint: 'si son camp gagne' },
    { key: 'liberalLose', label: 'Libéral', kind: 'number', hint: 'si son camp perd', showIf: 'countsResult' },
    { key: 'fascisteLose', label: 'Fasciste', kind: 'number', hint: 'si son camp perd', showIf: 'countsResult' },
    { key: 'hitlerLose', label: 'Hitler', kind: 'number', hint: 'si son camp perd', showIf: 'countsResult' },
  ],
  normalizeConfig(c = {}) {
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
    return {
      countsResult: c.countsResult === undefined ? true : c.countsResult === true || c.countsResult === 'true' || c.countsResult === 'on',
      liberal: num(c.liberal, 2),
      fasciste: num(c.fasciste, 2),
      hitler: num(c.hitler, 3),
      liberalLose: num(c.liberalLose, 0),
      fascisteLose: num(c.fascisteLose, 0),
      hitlerLose: num(c.hitlerLose, 0),
    };
  },
  choices(game) {
    const c = { role: { scope: 'player', label: 'Ton rôle', secret: true, options: ROLES } };
    if (game.config.countsResult)
      c.winner = {
        scope: 'table',
        label: 'Camp gagnant',
        options: [
          { value: 'liberal', label: 'Libéraux' },
          { value: 'fasciste', label: 'Fascistes' },
        ],
      };
    return c;
  },
  // data = { players: { pid: { role } }, table: { winner } }
  scoreTable({ game, table, data }) {
    const cfg = game.config;
    const scores = {};
    const missing = table.playerIds.filter((p) => !data.players?.[p]?.role);
    const winner = data.table?.winner;
    if (cfg.countsResult && !winner) return { scores, missing, needs: 'le camp gagnant' };
    for (const p of table.playerIds) {
      const role = data.players?.[p]?.role;
      if (!role) continue;
      const won = !cfg.countsResult || CAMP[role] === winner;
      scores[p] = won ? cfg[role] : cfg[role + 'Lose'];
    }
    return { scores, missing };
  },
};

// ----------------------------------------------------------------------------
export const GAME_TYPES = { standard, codenames, [secretHitler.id]: secretHitler };

export function getGameType(id) {
  return GAME_TYPES[id] || standard;
}

// Description envoyée au navigateur (sans les fonctions).
export function listGameTypes() {
  return Object.values(GAME_TYPES).map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    special: !!t.special,
    preset: t.preset || null,
    minCapacity: t.minCapacity || 1,
    configFields: t.configFields || [],
    hasTeams: !!t.teams,
  }));
}
