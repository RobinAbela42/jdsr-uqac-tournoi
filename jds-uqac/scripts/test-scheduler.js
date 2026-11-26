// Teste l'algorithme sur plusieurs scénarios : node scripts/test-scheduler.js
import { generateRounds, suggestedRoundCount, scheduleStats, minPauses } from '../lib/scheduler.js';

function scenario(name, nbPlayers, caps, mins = [], showRounds = false) {
  const players = Array.from({ length: nbPlayers }, (_, i) => 'p' + i);
  const games = caps.map((c, i) => ({ id: 'g' + i, capacity: c, minPlayers: mins[i] || 1, type: 'standard' }));
  const R = Math.max(suggestedRoundCount(nbPlayers, games), 3);
  const t0 = Date.now();
  const rounds = generateRounds({ playerIds: players, games, count: R, seed: 42 });
  const ms = Date.now() - t0;
  // vérifs dures : chaque joueur exactement une fois par étape (table ou pause), min et max respectés
  for (const [ri, r] of rounds.entries()) {
    const seen = r.tables.flatMap((t) => t.playerIds).concat(r.paused || []);
    if (seen.length !== nbPlayers || new Set(seen).size !== nbPlayers) throw new Error(`${name}: étape ${ri} invalide`);
  }
  const st = scheduleStats(players, games, rounds);
  if (st.underMin) throw new Error(`${name}: ${st.underMin} table(s) hors limites min/max`);
  const pauseMin = minPauses(nbPlayers, games) * R;
  console.log(
    `${name.padEnd(42)} ${R} étapes, ${ms}ms | il manque un jeu à: ${Object.keys(st.missing).length} | ` +
      `paires 2+ fois: ${st.repeatedPairs} | pauses: ${st.pauses} (min ${pauseMin}) | hors min/max: ${st.underMin}`
  );
  if (showRounds)
    rounds.forEach((r, i) =>
      console.log(`    étape ${i + 1}: ` + r.tables.map((t) => `${t.gameId}×${t.playerIds.length}`).join(' ') + (r.paused ? ` pause×${r.paused.length}` : ''))
    );
}

scenario('16 joueurs, 4 jeux de 4', 16, [4, 4, 4, 4]);
scenario('12 joueurs, 3 jeux de 5', 12, [5, 5, 5], [3, 3, 3]);
scenario('20 joueurs, 5 jeux (6,5,4,4,4)', 20, [6, 5, 4, 4, 4], [2, 2, 2, 2, 2]);
scenario('10 joueurs, jeux inégaux (2,8)', 10, [2, 8]);
scenario('40 joueurs, 8 jeux de 6', 40, [6, 6, 6, 6, 6, 6, 6, 6], [3, 3, 3, 3, 3, 3, 3, 3]);
scenario('7 joueurs, 3 jeux (4,4,2)', 7, [4, 4, 2], [2, 2, 2]);
console.log('--- minimums stricts ---');
scenario('Ton cas : 8 j., SH 5-10 + 3 jeux 4-4', 8, [10, 4, 4, 4], [5, 4, 4, 4], true);
scenario('8 j., SH 5-10 + 3 jeux 4-6', 8, [10, 6, 6, 6], [5, 4, 4, 4], true);
scenario('11 j., SH 5-10, CN 4-8, 2 jeux 4-5', 11, [10, 8, 5, 5], [5, 4, 4, 4], true);
scenario('9 j., que des jeux 4-4 (pause obligée)', 9, [4, 4, 4], [4, 4, 4], true);
scenario('13 j., SH 5-7 + 3 jeux 3-4', 13, [7, 4, 4, 4], [5, 3, 3, 3]);

// --- Équipes Codenames ---------------------------------------------------------
import { getGameType } from '../lib/gameTypes.js';
function scenarioEquipes(name, nbPlayers, games, teams) {
  const players = Array.from({ length: nbPlayers }, (_, i) => 'p' + i);
  const gs = games.map((g, i) => ({ id: 'g' + i, minPlayers: 1, type: 'standard', ...g }));
  const cn = gs.find((g) => g.type === 'codenames');
  cn.groups = teams;
  const R = suggestedRoundCount(nbPlayers, gs);
  const t0 = Date.now();
  const rounds = generateRounds({ playerIds: players, games: gs, count: R, seed: 7 });
  let split = 0, unbalanced = 0, maxDiff = 0;
  const sides = [];
  for (const r of rounds)
    for (const t of r.tables) {
      if (t.gameId !== cn.id) continue;
      for (const g of teams) {
        const inside = g.filter((p) => t.playerIds.includes(p)).length;
        if (inside && inside < g.length) split++;
      }
      getGameType('codenames').decorateTable(t, cn);
      const d = Math.abs(t.sides[0].length - t.sides[1].length);
      maxDiff = Math.max(maxDiff, d);
      if (d > 1) unbalanced++;
      sides.push(t.sides.map((s) => s.join(',')).join('  VS  '));
    }
  const st = scheduleStats(players, gs, rounds);
  console.log(`${name.padEnd(38)} ${R} étapes, ${Date.now() - t0}ms | équipes coupées: ${split} | camps déséquilibrés: ${unbalanced} | manque un jeu: ${Object.keys(st.missing).length}`);
  sides.forEach((s) => console.log('    Codenames :', s));
}
scenarioEquipes('14 joueurs, Codenames 6 + 3 jeux', 14, [{ type: 'codenames', capacity: 6, minPlayers: 4 }, { capacity: 4 }, { capacity: 4 }, { capacity: 5 }], [['p0', 'p1', 'p2'], ['p3', 'p4'], ['p5', 'p6', 'p7'], ['p8', 'p9']]);
scenarioEquipes('20 joueurs, Codenames 8 + 4 jeux', 20, [{ type: 'codenames', capacity: 8, minPlayers: 4 }, { capacity: 5 }, { capacity: 5 }, { capacity: 4 }, { capacity: 6 }], [['p0', 'p1', 'p2', 'p3'], ['p4', 'p5', 'p6'], ['p7', 'p8'], ['p9', 'p10'], ['p11', 'p12', 'p13']]);
