import { api, poll, esc, toast, couleurJeu, fmtPts, nomJeu, pseudo, typeDe, CAMPS } from './common.js';

const app = document.getElementById('app');
let mdp = sessionStorage.getItem('jds-admin') || '';
let state = null;
let connecte = false;
let editionJeu = null; // id du jeu en cours d'édition
let etapePoints = null; // étape affichée dans la saisie des points
let renduEnAttente = false;
let renduTimer = null;

// ------------------------------------------------------------------ Connexion
async function connexion(motDePasse) {
  try {
    const { state: s } = await api('adminCheck', {}, motDePasse);
    mdp = motDePasse;
    sessionStorage.setItem('jds-admin', mdp);
    connecte = true;
    state = s;
    poll(
      (s) => {
        state = s;
        render();
      },
      3000,
      mdp
    );
    return true;
  } catch (e) {
    return e.message;
  }
}

function renderConnexion(message = '') {
  app.innerHTML = `
    <section style="max-width:420px">
      <h2>Connexion admin</h2>
      <form class="bloc" id="f" style="display:grid;gap:12px">
        <label>Mot de passe<input type="password" name="mdp" required autofocus autocomplete="current-password" /></label>
        <p class="erreur">${esc(message)}</p>
        <button class="principal">Se connecter</button>
      </form>
    </section>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const r = await connexion(e.target.mdp.value);
    if (r !== true) renderConnexion(r);
  };
}

if (mdp) connexion(mdp).then((r) => r !== true && renderConnexion());
else renderConnexion();

// ------------------------------------------------------------------ Actions
async function agir(action, params = {}, okMsg) {
  try {
    const { state: s, result } = await api(action, params, mdp);
    state = s;
    const warnings = result?.warnings || [];
    if (warnings.length) toast(warnings.join(' '), true);
    else if (okMsg) toast(okMsg);
    render(true);
    return result ?? true;
  } catch (e) {
    if (e.status === 401) {
      sessionStorage.removeItem('jds-admin');
      location.reload();
    }
    toast(e.message, true);
    return false;
  }
}

// Pour les points : on met l'état à jour sans tout redessiner tout de suite
// (sinon le champ ou le bouton suivant perdrait le focus pendant les clics rapides).
async function agirSilencieux(action, params) {
  try {
    const { state: s } = await api(action, params, mdp);
    state = s;
    majTotaux();
    renduEnAttente = true;
    clearTimeout(renduTimer);
    renduTimer = setTimeout(() => !saisieEnCours() && render(true), 900);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}
function majTotaux() {
  app.querySelectorAll('[data-total], [data-ptotal]').forEach((el) => {
    const p = state.players.find((x) => x.id === (el.dataset.total || el.dataset.ptotal));
    if (p) el.textContent = fmtPts(p.total);
  });
}

// Ne pas écraser un champ en cours de saisie : on reporte le rendu.
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (renduEnAttente && !saisieEnCours()) render(true);
  }, 0);
});
const saisieEnCours = () => app.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);

// ------------------------------------------------------------------ Rendu
function render(force = false) {
  if (!connecte || !state) return;
  if (saisieEnCours() && (!force || document.activeElement.closest('form'))) {
    renduEnAttente = true;
    return;
  }
  renduEnAttente = false;
  const actif = document.activeElement?.dataset?.focus;
  const ouverts = [...app.querySelectorAll('details[open]')].map((d) => d.id);
  app.innerHTML = `
    ${sectionDeroulement()}
    ${state.status !== 'registration' ? sectionPoints() : ''}
    <div class="colonnes">
      ${sectionJeux()}
      <div style="display:grid;gap:28px;align-content:start">${sectionEquipes()}${sectionJoueurs()}</div>
    </div>
    ${state.status !== 'registration' ? sectionPlanning() : ''}
    ${sectionReinit()}`;
  ouverts.forEach((id) => id && document.getElementById(id)?.setAttribute('open', ''));
  brancher();
  if (actif) app.querySelector(`[data-focus="${actif}"]`)?.focus();
}

function sectionDeroulement() {
  const s = state;
  let etat, boutons;
  if (s.status === 'registration') {
    etat = 'Inscriptions en cours';
    boutons = `<button class="principal" data-act="start" ${s.activePlayers < 2 ? 'disabled' : ''}>Démarrer le tournoi</button>`;
  } else if (s.status === 'running') {
    etat = `Étape ${s.currentRound + 1} en cours`;
    boutons = `
      <button data-act="prev" ${s.currentRound <= 0 ? 'disabled' : ''}>Étape précédente</button>
      <button class="principal" data-act="next">Passer à l'étape ${s.currentRound + 2}</button>
      <button class="danger" data-act="finish">Terminer le tournoi</button>`;
  } else {
    etat = 'Tournoi terminé';
    boutons = `<button data-act="prev">Rouvrir à l'étape ${s.currentRound + 1}</button>`;
  }
  return `
    <section>
      <div class="entete">
        <div class="etat">${etat}</div>
        <span class="doux num">${s.activePlayers} joueur${s.activePlayers > 1 ? 's' : ''} · ${s.seats} places</span>
      </div>
      <div class="controles">${boutons}</div>
      ${s.activePlayers > s.seats ? `<p class="erreur">Il y a plus de joueurs que de places : ajoute des places ou retire des joueurs.</p>` : ''}
      ${
        s.activePlayers <= s.seats && s.pausesPerRound > 0
          ? `<p class="erreur">Avec ${s.activePlayers} joueurs et les minimums actuels, impossible de remplir les tables exactement : ${s.pausesPerRound} joueur${s.pausesPerRound > 1 ? 's seront' : ' sera'} en pause à chaque étape. Ajuste les minimums ou le nombre de joueurs pour l'éviter.</p>`
          : ''
      }
      ${s.storeKind === 'memory' ? `<p class="erreur">Stockage temporaire en mémoire : configure Upstash Redis pour que les données soient conservées (voir README).</p>` : ''}
      <div class="bloc"><p class="doux petit">Lien à partager aux joueurs</p><p class="partage">${esc(location.origin)}</p></div>
    </section>`;
}

// ------------------------------------------------------------------ Points
function ligneScore(pid, round, game) {
  const v = state.scores[round]?.[pid];
  const par = state.scoreBy?.[round]?.[pid];
  const marque = par === 'auto' ? '<span class="auto" title="Calculé automatiquement">auto</span>' : par === 'player' ? '<span class="auto joueur" title="Entré par le joueur">joueur</span>' : '';
  const p = state.players.find((x) => x.id === pid);
  const nom = esc(pseudo(state, pid));
  let role = '';
  const choixJoueur = Object.entries(game.choices || {}).filter(([, c]) => c.scope === 'player');
  for (const [key, c] of choixJoueur) {
    const cur = state.tableData[`${round}:${game.id}`]?.players?.[pid]?.[key] ?? '';
    role += `<select class="mini" data-choice="${key}" data-game="${game.id}" data-player="${pid}" data-focus="c-${round}-${pid}-${key}" aria-label="${esc(c.label)} de ${nom}">
      <option value="">${esc(c.label.replace(/^Ton /, '').replace(/^./, (x) => x.toUpperCase()))} ?</option>
      ${c.options.map((o) => `<option value="${o.value}" ${o.value === cur ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>`;
  }
  return `<div class="score-ligne">
    <span class="nom"><span style="${p?.removed ? 'text-decoration:line-through' : ''}">${nom}</span>${role}</span>
    <button class="pas" data-delta="-1" data-player="${pid}" aria-label="Retirer 1 point à ${nom}">−1</button>
    <span class="champ"><input type="number" step="any" inputmode="decimal" data-score="${pid}" data-focus="s-${round}-${pid}" value="${v ?? ''}" aria-label="Points de ${nom}" />${marque}</span>
    <button class="pas" data-delta="1" data-player="${pid}" aria-label="Ajouter 1 point à ${nom}">+1</button>
    <span class="total" data-total="${pid}">${fmtPts(p?.total || 0)}</span>
  </div>`;
}

function sectionPoints() {
  const cr = state.currentRound;
  etapePoints = cr; // la section Points ne concerne que l'étape en cours
  const r = state.rounds[cr];
  const fini = state.status === 'finished';
  return `
    <section>
      <div class="entete">
        <h2>Points ${fini ? 'de la dernière étape' : `de l'étape ${cr + 1}`}</h2>
      </div>
      <p class="doux petit">Les joueurs entrent leur score depuis leur téléphone (pastille « joueur »). Tu peux compléter ou corriger ici avec −1 / +1 ou en tapant une valeur. Pour ajuster le total d'un joueur après coup, utilise les boutons de la section Joueurs.</p>
      <div class="tables">
        ${(r?.tables || []).map((t) => tablePoints(t, cr)).join('')}
      </div>
      ${r?.paused?.length ? `<p class="doux">En pause à cette étape : ${r.paused.map((id) => esc(pseudo(state, id))).join(', ')}</p>` : ''}
    </section>`;
}

function tablePoints(t, round) {
  const game = state.games.find((g) => g.id === t.gameId);
  const type = typeDe(state, game);
  let corps;
  if (t.sides) {
    corps = t.sides
      .map((side, i) => `<p class="camp" style="--c:${CAMPS[i].couleur}">Camp ${CAMPS[i].nom.toLowerCase()}</p>${side.map((pid) => ligneScore(pid, round, game)).join('')}`)
      .join('');
  } else corps = t.playerIds.map((pid) => ligneScore(pid, round, game)).join('');

  let entete = '';
  const choixTable = Object.entries(game.choices || {}).filter(([, c]) => c.scope === 'table');
  for (const [key, c] of choixTable) {
    const cur = state.tableData[`${round}:${game.id}`]?.table?.[key] ?? '';
    entete += `<label class="choix-table">${esc(c.label)}
      <select data-choice="${key}" data-game="${game.id}" data-focus="t-${round}-${game.id}-${key}">
        <option value="">pas encore indiqué</option>
        ${c.options.map((o) => `<option value="${o.value}" ${o.value === cur ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select></label>`;
  }
  const auto = game.choices && Object.keys(game.choices).length;
  const note = auto
    ? `<p class="doux petit">${round === state.currentRound && state.status === 'running'
        ? "Les joueurs déclarent leur rôle sur leur téléphone. Les points sont calculés au passage à l'étape suivante."
        : 'Points calculés à partir des rôles. Modifier un rôle ou le camp gagnant les recalcule ; une saisie manuelle reste prioritaire.'}</p>`
    : '';
  return `<div class="table" style="--c:${couleurJeu(state, t.gameId)}">
    <h3>${esc(game.name)}${type?.special && type.label !== game.name ? ` <span class="badge">${esc(type.label)}</span>` : ''}</h3>
    ${entete}${note}
    ${corps}
  </div>`;
}

// ------------------------------------------------------------------ Jeux
function champsConfig(g, type) {
  const fields = type?.configFields || [];
  if (!fields.length) return '';
  const cfg = g.config || {};
  return `<fieldset class="large config"><legend>Réglages ${esc(type.label)}</legend>
    ${fields
      .map((f) => {
        const cache = f.showIf && !cfg[f.showIf] ? 'hidden' : '';
        if (f.kind === 'boolean')
          return `<label class="interrupteur large" ${cache}><input type="checkbox" data-cfg="${f.key}" data-kind="boolean" ${cfg[f.key] ? 'checked' : ''} /> ${esc(f.label)}</label>`;
        return `<label data-showif="${f.showIf || ''}" ${cache}>${esc(f.label)}${f.hint ? ` <span class="doux petit">${esc(f.hint)}</span>` : ''}
          <input type="number" step="any" data-cfg="${f.key}" data-kind="number" value="${cfg[f.key] ?? ''}" /></label>`;
      })
      .join('')}
  </fieldset>`;
}

function formJeu(g = {}) {
  const type = typeDe(state, g) || typeDe(state, { type: 'standard' });
  return `
    <form class="bloc grille-form" data-form-jeu="${g.id || ''}">
      <label class="large">Nom<input name="name" required maxlength="60" value="${esc(g.name)}" /></label>
      <label>Places max<input name="capacity" type="number" min="${type?.minCapacity || 1}" max="100" required value="${g.capacity ?? 4}" /></label>
      <label>Joueurs min<input name="minPlayers" type="number" min="1" max="100" required value="${g.minPlayers ?? 2}" /></label>
      <label class="large">Description (facultatif)<input name="description" maxlength="300" value="${esc(g.description)}" placeholder="Table du fond, règles rapides…" /></label>
      ${g.id ? champsConfig(g, type) : ''}
      <div class="rangee large">
        <button class="principal">${g.id ? 'Enregistrer' : 'Ajouter le jeu'}</button>
        ${g.id ? `<button type="button" data-annuler>Annuler</button>` : ''}
      </div>
    </form>`;
}

function resumeJeu(g) {
  const type = typeDe(state, g);
  const bits = [`${g.minPlayers} à ${g.capacity} joueurs`];
  if (g.maxTeamSize) bits.push(`équipes de ${g.maxTeamSize} max`);
  if (g.type === 'secret-hitler') {
    const c = g.config;
    bits.push(c.countsResult ? `gagnants : lib. ${fmtPts(c.liberal)}, fasc. ${fmtPts(c.fasciste)}, Hitler ${fmtPts(c.hitler)}` : `lib. ${fmtPts(c.liberal)}, fasc. ${fmtPts(c.fasciste)}, Hitler ${fmtPts(c.hitler)}`);
  }
  if (g.description) bits.push(esc(g.description));
  return `<div class="ligne" style="--c:${couleurJeu(state, g.id)}"><i></i>
    <div><strong>${esc(g.name)}</strong>${type?.special ? ` <span class="badge">${type.label === g.name ? 'spécial' : esc(type.label)}</span>` : ''}<div class="doux petit num">${bits.join(' · ')}</div></div>
    <div class="rangee"><button class="lien" data-edit="${g.id}">Modifier</button><button class="lien" data-del="${g.id}">Retirer</button></div></div>`;
}

function sectionJeux() {
  const jeux = state.games.filter((g) => !g.deleted);
  const speciaux = state.gameTypes.filter((t) => t.special);
  return `
    <section>
      <div class="entete"><h2>Jeux du tournoi</h2><span class="doux num">${jeux.length} jeu${jeux.length > 1 ? 'x' : ''} · ${state.seats} places</span></div>
      ${state.status === 'running' ? `<p class="doux petit">Modifier les places, ajouter ou retirer un jeu recalcule les étapes à venir. Les étapes passées et en cours ne changent pas.</p>` : ''}
      <div class="liste">
        ${jeux.map((g) => (editionJeu === g.id ? formJeu(g) : resumeJeu(g))).join('') || '<p class="vide">Aucun jeu pour l\'instant. Pioche dans la bibliothèque ou crée un jeu ci-dessous.</p>'}
      </div>
      <h3>Bibliothèque de jeux spéciaux</h3>
      <div class="liste">
        ${speciaux
          .map((t) => {
            const n = jeux.filter((g) => g.type === t.id).length;
            return `<div class="ligne biblio"><i style="background:var(--encre)"></i>
              <div><strong>${esc(t.label)}</strong> <span class="doux petit num">${t.preset ? `${t.preset.minPlayers} à ${t.preset.capacity} joueurs` : ''}</span><div class="doux petit">${esc(t.description)}</div></div>
              ${n ? `<span class="doux petit">Dans le tournoi</span>` : `<button data-lib="${t.id}">Ajouter</button>`}</div>`;
          })
          .join('')}
      </div>
      <h3>Jeu personnalisé</h3>
      ${formJeu()}
    </section>`;
}

// ------------------------------------------------------------------ Équipes & joueurs
function sectionEquipes() {
  const jeux = state.games.filter((g) => !g.deleted && g.teams);
  if (!jeux.length) return '';
  return jeux
    .map((g) => {
      const dansEquipe = new Set(g.teams.flat());
      const seuls = state.players.filter((p) => !p.removed && !dansEquipe.has(p.id)).length;
      return `<section>
        <div class="entete"><h2>Équipes ${esc(g.name)}</h2><span class="doux petit">${g.maxTeamSize} max par équipe</span></div>
        <p class="doux petit">${state.status === 'registration' ? 'Les joueurs forment leurs équipes depuis leur téléphone avant le début.' : "Équipes verrouillées. Retirer quelqu'un recalcule les étapes à venir."} ${seuls} joueur${seuls > 1 ? 's' : ''} sans équipe (complété${seuls > 1 ? 's' : ''} au hasard).</p>
        <div class="liste">
          ${
            g.teams
              .map(
                (t) => `<div class="bloc pions-liste">${t
                  .map((pid) => `<span class="pion"><i style="--c:var(--encre)"></i>${esc(pseudo(state, pid))}<button class="croix" data-unteam="${pid}" data-game="${g.id}" aria-label="Retirer ${esc(pseudo(state, pid))} de l'équipe">×</button></span>`)
                  .join('')}${t.length > g.maxTeamSize ? '<span class="erreur">trop grande</span>' : ''}</div>`
              )
              .join('') || '<p class="vide">Aucune équipe formée pour le moment.</p>'
          }
        </div>
      </section>`;
    })
    .join('');
}

function sectionJoueurs() {
  // ordre alphabétique : les lignes ne bougent pas pendant qu'on clique sur +1
  const joueurs = [...state.players].sort((a, b) => a.removed - b.removed || a.pseudo.localeCompare(b.pseudo));
  return `
    <section>
      <div class="entete"><h2>Joueurs</h2><span class="doux num">${state.activePlayers} / ${state.seats}</span></div>
      <label class="interrupteur"><input type="checkbox" id="inscriptions" ${state.registrationOpen ? 'checked' : ''} /> Inscriptions ouvertes</label>
      ${state.status === 'running' && state.registrationOpen ? `<p class="doux petit">Pendant le tournoi, chaque nouvelle inscription recalcule les étapes à venir.</p>` : ''}
      <p class="doux petit">−1 / +1 ajoute ou retire des points au total du joueur, à tout moment (bonus, pénalité, correction d'une étape passée).</p>
      <div class="liste">
        ${joueurs
          .map((p) =>
            p.removed
              ? `<div class="ligne retire"><i style="background:var(--trait);border-radius:50%"></i><div><strong>${esc(p.pseudo)}</strong> <span class="doux num">${fmtPts(p.total)} pts</span> <span class="doux petit">(retiré)</span></div><span></span></div>`
              : `<div class="joueur-ligne">
                  <div><strong>${esc(p.pseudo)}</strong>
                    <div class="doux petit num"><span data-ptotal="${p.id}">${fmtPts(p.total)}</span> pts${p.adjustment ? ` · dont ${p.adjustment > 0 ? '+' : ''}${fmtPts(p.adjustment)} ajouté${Math.abs(p.adjustment) > 1 ? 's' : ''} à la main` : ''}</div></div>
                  <div class="rangee">
                    <button class="pas" data-adj="-1" data-player="${p.id}" aria-label="Retirer 1 point à ${esc(p.pseudo)}">−1</button>
                    <button class="pas" data-adj="1" data-player="${p.id}" aria-label="Ajouter 1 point à ${esc(p.pseudo)}">+1</button>
                    <button class="pas autre" data-adj="?" data-player="${p.id}" aria-label="Ajouter ou retirer un autre montant à ${esc(p.pseudo)}">±</button>
                    <button class="lien" data-kick="${p.id}">Retirer</button>
                  </div>
                </div>`
          )
          .join('') || '<p class="vide">Personne n\'est encore inscrit.</p>'}
      </div>
    </section>`;
}

function sectionPlanning() {
  const cr = state.currentRound;
  const noms = (ids) => ids.map((id) => esc(pseudo(state, id))).join(', ');
  return `
    <section>
      <div class="entete"><h2>Planning calculé</h2><button data-act="replan">Recalculer les étapes à venir</button></div>
      <details class="planning bloc" id="planning">
        <summary>Voir les ${state.rounds.length} étapes</summary>
        ${state.rounds
          .map(
            (r, i) => `<div class="etape-plan ${i === cr ? 'actuelle' : ''}">
            <strong>Étape ${i + 1}${i === cr ? ' (en cours)' : i < cr ? ' (jouée)' : ''}</strong>
            ${r.tables
              .map(
                (t) => `<div><span style="color:${couleurJeu(state, t.gameId)}">●</span> <strong>${esc(nomJeu(state, t.gameId))}</strong> : ${
                  t.sides ? `${noms(t.sides[0])} <span class="doux">contre</span> ${noms(t.sides[1])}` : noms(t.playerIds)
                }</div>`
              )
              .join('')}
            ${r.paused?.length ? `<div class="doux">En pause : ${noms(r.paused)}</div>` : ''}
          </div>`
          )
          .join('')}
        <p class="doux petit" style="padding-top:8px">Si tu dépasses la dernière étape, de nouvelles étapes sont calculées automatiquement.</p>
      </details>
    </section>`;
}

function sectionReinit() {
  return `
    <section>
      <h2>Réinitialiser</h2>
      <div class="rangee">
        <button class="danger" data-reset="garder">Recommencer le tournoi (garder joueurs, équipes et jeux)</button>
        <button class="danger" data-reset="tout">Tout effacer sauf les jeux</button>
      </div>
    </section>`;
}

// ------------------------------------------------------------------ Événements
const CONFIRM = {
  start: "Démarrer le tournoi ? Les inscriptions et les équipes seront verrouillées et l'ordre des jeux sera calculé.",
  finish: 'Terminer le tournoi ? Tu pourras le rouvrir ensuite.',
  replan: "Recalculer toutes les étapes à venir ? L'étape en cours ne change pas.",
};
const OK = { start: 'Tournoi démarré', next: 'Étape suivante lancée', prev: 'Retour en arrière', finish: 'Tournoi terminé', replan: 'Étapes à venir recalculées' };

function brancher() {
  app.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const a = b.dataset.act;
      if (CONFIRM[a] && !confirm(CONFIRM[a])) return;
      b.disabled = true;
      const avant = state.currentRound;
      await agir(a, {}, OK[a]);
      if (a === 'next' || a === 'prev') etapePoints = state.currentRound;
      if (a === 'next' && state.currentRound === avant) etapePoints = avant;
      render(true);
    };
  });


  app.querySelectorAll('[data-score]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const v = inp.value.trim();
      const ok = await agirSilencieux('setScore', { round: etapePoints, playerId: inp.dataset.score, points: v === '' ? null : Number(v) });
      inp.style.borderColor = ok ? 'var(--vert)' : 'var(--rouge)';
    });
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && inp.blur());
  });

  app.querySelectorAll('[data-delta]').forEach((b) => {
    b.onclick = () => {
      const pid = b.dataset.player;
      const delta = Number(b.dataset.delta);
      const inp = app.querySelector(`[data-score="${pid}"]`);
      inp.value = String(Math.round(((Number(inp.value) || 0) + delta) * 100) / 100); // affichage immédiat
      app.querySelector(`[data-total="${pid}"]`)?.classList.add('maj');
      agirSilencieux('addScore', { round: etapePoints, playerId: pid, delta });
    };
  });

  app.querySelectorAll('[data-adj]').forEach((b) => {
    b.onclick = () => {
      const pid = b.dataset.player;
      let delta = Number(b.dataset.adj);
      if (b.dataset.adj === '?') {
        const v = prompt(`Points à ajouter à ${pseudo(state, pid)} (négatif pour retirer, ex. -3) :`);
        if (v === null) return;
        delta = Number(String(v).replace(',', '.'));
        if (!Number.isFinite(delta) || delta === 0) return toast('Montant invalide.', true);
      }
      const el = app.querySelector(`[data-ptotal="${pid}"]`);
      if (el) el.textContent = fmtPts(Math.round(((state.players.find((x) => x.id === pid)?.total || 0) + delta) * 100) / 100);
      const p = state.players.find((x) => x.id === pid);
      if (p) p.total = Math.round((p.total + delta) * 100) / 100; // affichage immédiat, confirmé par le serveur
      agirSilencieux('adjustPlayer', { playerId: pid, delta });
    };
  });

  app.querySelectorAll('select[data-choice]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      sel.blur();
      await agir('adminTableChoice', {
        round: etapePoints,
        gameId: sel.dataset.game,
        playerId: sel.dataset.player,
        key: sel.dataset.choice,
        value: sel.value || null,
      });
    });
  });

  app.querySelectorAll('[data-form-jeu]').forEach((f) => {
    f.querySelectorAll('[data-kind="boolean"]').forEach((cb) =>
      cb.addEventListener('change', () => {
        f.querySelectorAll(`[data-showif="${cb.dataset.cfg}"]`).forEach((el) => (el.hidden = !cb.checked));
      })
    );
    f.onsubmit = async (e) => {
      e.preventDefault();
      const id = f.dataset.formJeu;
      const game = Object.fromEntries(new FormData(f));
      const config = {};
      f.querySelectorAll('[data-cfg]').forEach((el) => (config[el.dataset.cfg] = el.dataset.kind === 'boolean' ? el.checked : el.value));
      if (Object.keys(config).length) game.config = config;
      document.activeElement?.blur();
      const r = id ? await agir('updateGame', { id, game }, 'Jeu modifié') : await agir('createGame', { game }, 'Jeu ajouté');
      if (r) {
        editionJeu = null;
        if (!id) f.reset();
        render(true);
      }
    };
    f.querySelector('[data-annuler]')?.addEventListener('click', () => {
      editionJeu = null;
      document.activeElement?.blur();
      render(true);
    });
  });
  app.querySelectorAll('[data-lib]').forEach((b) => {
    b.onclick = () => {
      const t = state.gameTypes.find((x) => x.id === b.dataset.lib);
      agir('createGame', { game: { type: t.id, ...t.preset } }, `${t.label} ajouté au tournoi`);
    };
  });
  app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => ((editionJeu = b.dataset.edit), render(true))));
  app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const nom = nomJeu(state, b.dataset.del);
      if (confirm(`Retirer « ${nom} » du tournoi ?`)) agir('deleteGame', { id: b.dataset.del }, 'Jeu retiré');
    };
  });
  app.querySelectorAll('[data-unteam]').forEach((b) => {
    b.onclick = () => {
      const nom = pseudo(state, b.dataset.unteam);
      if (confirm(`Retirer ${nom} de son équipe ?`)) agir('adminRemoveFromTeam', { gameId: b.dataset.game, playerId: b.dataset.unteam }, `${nom} retiré de l'équipe`);
    };
  });
  app.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => {
      const nom = pseudo(state, b.dataset.kick);
      if (confirm(`Retirer ${nom} du tournoi ?`)) agir('removePlayer', { id: b.dataset.kick }, `${nom} retiré`);
    };
  });
  document.getElementById('inscriptions')?.addEventListener('change', (e) => {
    agir('setRegistration', { open: e.target.checked }, e.target.checked ? 'Inscriptions ouvertes' : 'Inscriptions fermées');
  });
  app.querySelectorAll('[data-reset]').forEach((b) => {
    b.onclick = () => {
      const garder = b.dataset.reset === 'garder';
      const msg = garder
        ? 'Recommencer ? Le planning et tous les points seront effacés. Les joueurs, les équipes et les jeux restent.'
        : 'Tout effacer ? Les joueurs, les équipes, le planning et les points seront supprimés. Les jeux restent.';
      if (confirm(msg)) agir('resetTournament', { keepPlayers: garder }, 'Tournoi réinitialisé');
    };
  });
}
