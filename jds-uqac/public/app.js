import { api, poll, esc, toast, couleurJeu, estClaire, fmtPts, tableDe, nomJeu, pseudo, CAMPS } from './common.js';

const app = document.getElementById('app');
const qui = document.getElementById('qui');
const nav = document.getElementById('onglets');

let state = null;
let me = JSON.parse(localStorage.getItem('jds-moi') || 'null'); // { id, pseudo, token }
let onglet = 'parcours';
let derniereEtapeAnimee = null;
let mesChoix = {}; // mes choix secrets de l'étape en cours (ex. rôle Secret Hitler), par jeu

const poller = poll(async (s) => {
  state = s;
  await chargerMesChoix();
  render();
});

// Les rôles déclarés sont cachés dans l'état public : on redemande les miens au serveur.
async function chargerMesChoix() {
  if (!me || state.status !== 'running') return (mesChoix = {});
  const t = tableDe(state, state.currentRound, me.id);
  const g = t && state.games.find((x) => x.id === t.gameId);
  if (!g?.choices) return (mesChoix = {});
  try {
    const { result } = await api('whoami', { token: me.token });
    mesChoix = result?.myChoices || {};
  } catch {}
}

function moiValide() {
  if (!me || !state) return false;
  const p = state.players.find((p) => p.id === me.id);
  if (!p || p.removed) {
    localStorage.removeItem('jds-moi');
    me = null;
    return false;
  }
  return true;
}

// Ne pas redessiner la page pendant que le joueur tape son score.
let renduEnAttente = false;
const saisieEnCours = () => app.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
document.addEventListener('focusout', () =>
  setTimeout(() => {
    if (renduEnAttente && !saisieEnCours()) render();
  }, 0)
);

function render() {
  if (saisieEnCours() && document.activeElement.id === 'mon-score') {
    renduEnAttente = true;
    return;
  }
  renduEnAttente = false;
  const inscrit = moiValide();
  qui.textContent = inscrit ? me.pseudo : '';
  const enJeu = state.status !== 'registration';
  if (!inscrit) {
    nav.hidden = true;
    return enJeu && !state.registrationOpen ? renderSpectateur() : renderInscription();
  }
  if (!enJeu) {
    nav.hidden = true;
    return renderAttente();
  }
  renderOnglets();
  if (onglet === 'classement') renderClassement();
  else if (onglet === 'tables') renderTables();
  else renderParcours();
}

// ---------------------------------------------------------------- Inscription
function renderInscription() {
  const complet = state.activePlayers >= state.seats;
  const ferme = !state.registrationOpen || state.status === 'finished';
  let bloc;
  if (state.seats === 0) bloc = `<p class="vide">Les jeux ne sont pas encore prêts. Reviens dans un instant.</p>`;
  else if (ferme) bloc = `<p class="vide">Les inscriptions sont fermées.</p>`;
  else if (complet) bloc = `<p class="vide">Le tournoi est complet : les ${state.seats} places sont prises.</p>`;
  else
    bloc = `
    <form class="bloc" id="form-inscription" style="display:grid;gap:12px">
      <label>Ton pseudo
        <input name="pseudo" maxlength="20" autocomplete="nickname" autocapitalize="words" required autofocus placeholder="ex. Meeple Masqué" />
      </label>
      <p class="erreur" id="erreur"></p>
      <button class="principal" type="submit">Rejoindre le tournoi</button>
    </form>`;

  app.innerHTML = `
    <section>
      <h2>Rejoins la partie</h2>
      <p class="doux">Choisis un pseudo. Au début du tournoi, tu verras dans quel ordre tu joues à chaque jeu.</p>
      ${bloc}
      <p class="doux petit num">${state.activePlayers} inscrit${state.activePlayers > 1 ? 's' : ''} sur ${state.seats} places</p>
    </section>
    ${sectionJeux()}`;

  const form = document.getElementById('form-inscription');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { result, state: s } = await api('register', { pseudo: form.pseudo.value });
      me = result;
      localStorage.setItem('jds-moi', JSON.stringify(me));
      state = s;
      poller.setVersion(s.version);
      render();
    } catch (err) {
      document.getElementById('erreur').textContent = err.message;
      btn.disabled = false;
    }
  });
}

function renderSpectateur() {
  app.innerHTML = `
    <section>
      <h2>${state.status === 'finished' ? 'Le tournoi est terminé' : 'Le tournoi a commencé'}</h2>
      <p class="doux">Les inscriptions sont fermées. Voici le classement.</p>
    </section>
    ${sectionClassement()}`;
}

// ---------------------------------------------------------------- Salle d'attente
function renderAttente() {
  const joueurs = state.players.filter((p) => !p.removed);
  app.innerHTML = `
    <section>
      <h2>C'est noté, ${esc(me.pseudo)}</h2>
      <p class="doux">Le tournoi n'a pas encore commencé. Garde cette page ouverte : ton premier jeu s'affichera ici.</p>
    </section>
    <section>
      <div class="entete"><h3>Joueurs inscrits</h3><span class="doux num">${joueurs.length} / ${state.seats}</span></div>
      <div class="pions-liste">
        ${joueurs.map((p) => `<span class="pion ${p.id === me.id ? 'moi' : ''}"><i></i>${esc(p.pseudo)}</span>`).join('')}
      </div>
    </section>
    ${sectionEquipes()}
    ${sectionJeux()}
    <section><button class="lien" id="quitter">Me désinscrire</button></section>`;
  brancherEquipes();

  document.getElementById('quitter').onclick = async () => {
    if (!confirm('Te désinscrire du tournoi ?')) return;
    try {
      await api('leave', { token: me.token });
      localStorage.removeItem('jds-moi');
      me = null;
      poller.refresh();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

// ---------------------------------------------------------------- Équipes (Codenames…)
function sectionEquipes() {
  const jeux = state.games.filter((g) => !g.deleted && g.teams);
  return jeux
    .map((g) => {
      const monEquipe = g.teams.find((t) => t.includes(me.id)) || [];
      const autres = state.players.filter((p) => !p.removed && p.id !== me.id);
      const complet = monEquipe.length >= g.maxTeamSize;
      const lignes = autres
        .filter((p) => !monEquipe.includes(p.id))
        .map((p) => {
          const sonEquipe = g.teams.find((t) => t.includes(p.id));
          const plein = sonEquipe && sonEquipe.length >= g.maxTeamSize;
          const info = sonEquipe ? `<span class="doux petit">avec ${sonEquipe.filter((x) => x !== p.id).map((x) => esc(pseudo(state, x))).join(', ')}</span>` : '';
          return `<div class="equipe-ligne"><span><strong>${esc(p.pseudo)}</strong> ${info}</span>
            <button data-team-with="${p.id}" data-game="${g.id}" ${plein ? 'disabled' : ''}>${plein ? 'Complète' : sonEquipe ? 'Rejoindre' : 'Faire équipe'}</button></div>`;
        })
        .join('');
      return `<section>
        <div class="entete"><h3>Ton équipe pour ${esc(g.name)}</h3><span class="doux petit">${g.maxTeamSize} joueurs max</span></div>
        <p class="doux petit">Quand tu tomberas sur ${esc(g.name)}, tu joueras avec ton équipe, contre un camp de même taille. Sans équipe, tu seras placé·e au hasard.</p>
        ${
          monEquipe.length
            ? `<div class="bloc"><div class="pions-liste">${monEquipe.map((id) => `<span class="pion ${id === me.id ? 'moi' : ''}"><i></i>${esc(pseudo(state, id))}</span>`).join('')}</div>
               <div class="rangee" style="margin-top:10px"><button class="lien" data-team-leave="${g.id}">Quitter l'équipe</button>${complet ? '<span class="doux petit">Équipe complète</span>' : ''}</div></div>`
            : ''
        }
        ${complet ? '' : `<details class="bloc"><summary style="cursor:pointer;font-weight:600">${monEquipe.length ? 'Ajouter quelqu\'un à mon équipe' : 'Choisir un coéquipier'}</summary><div class="liste" style="display:grid;gap:6px;margin-top:10px">${lignes || '<p class="doux">Personne d\'autre pour le moment.</p>'}</div></details>`}
      </section>`;
    })
    .join('');
}

function brancherEquipes() {
  app.querySelectorAll('[data-team-with]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const { state: s } = await api('joinTeam', { token: me.token, gameId: b.dataset.game, withPlayerId: b.dataset.teamWith });
        state = s;
        poller.setVersion(s.version);
        render();
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
      }
    };
  });
  app.querySelectorAll('[data-team-leave]').forEach((b) => {
    b.onclick = async () => {
      try {
        const { state: s } = await api('leaveTeam', { token: me.token, gameId: b.dataset.teamLeave });
        state = s;
        poller.setVersion(s.version);
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
}

function sectionJeux() {
  const jeux = state.games.filter((g) => !g.deleted);
  if (!jeux.length) return '';
  return `
    <section>
      <h3>Les jeux</h3>
      <div class="jeux">
        ${jeux
          .map(
            (g) => `<div class="jeu-ligne" style="--c:${couleurJeu(state, g.id)}"><i></i>
              <div><div class="titre" style="font-weight:600">${esc(g.name)}</div>${g.description ? `<div class="doux petit">${esc(g.description)}</div>` : ''}</div>
              <span class="doux petit num">${g.minPlayers > 1 ? `${g.minPlayers}–` : ''}${g.capacity} joueurs</span></div>`
          )
          .join('')}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- Onglets
function renderOnglets() {
  nav.hidden = false;
  const items = [
    ['parcours', 'Parcours'],
    ['classement', 'Classement'],
    ['tables', 'Tables'],
  ];
  nav.innerHTML = items.map(([k, l]) => `<button data-k="${k}" aria-current="${k === onglet}">${l}</button>`).join('');
  nav.querySelectorAll('button').forEach((b) => (b.onclick = () => ((onglet = b.dataset.k), render(), scrollTo(0, 0))));
}

function renderParcours() {
  const cr = state.currentRound;
  const fini = state.status === 'finished';
  const t = tableDe(state, cr, me.id);
  let tuile;
  if (fini) {
    const moi = state.ranking.find((p) => p.id === me.id);
    tuile = `<div class="tuile" style="--c:var(--encre)">
      <div class="etape">Tournoi terminé</div>
      <div class="jeu">${moi ? `${moi.rank}<sup style="font-size:.45em">${moi.rank === 1 ? 'er' : 'e'}</sup>` : '—'}</div>
      <div class="desc">${moi ? `${fmtPts(moi.total)} points au total. Merci d'avoir joué !` : ''}</div></div>`;
  } else if (!t) {
    tuile = `<div class="tuile claire" style="--c:#fff"><div class="etape">Étape ${cr + 1}</div>
      <div class="jeu" style="font-size:2rem">Pause</div><div class="desc">Tu n'as pas de table à cette étape : les jeux ne peuvent pas accueillir tout le monde en respectant leur nombre minimum de joueurs. Ça tourne, ton tour reviendra vite.</div></div>`;
  } else {
    const g = state.games.find((x) => x.id === t.gameId);
    const c = couleurJeu(state, t.gameId);
    const autres = t.playerIds.filter((id) => id !== me.id);
    const anim = derniereEtapeAnimee !== cr;
    derniereEtapeAnimee = cr;
    tuile = `<div class="tuile ${estClaire(c) ? 'claire' : ''}" style="--c:${c};${anim ? '' : 'animation:none'}">
      <div class="etape">Étape ${cr + 1}, tu joues à</div>
      <div class="jeu">${esc(g?.name)}</div>
      ${
        t.sides
          ? blocCamps(t)
          : autres.length
          ? `<div><div class="etape" style="margin-bottom:6px">avec</div><div class="avec">${autres.map((id) => `<span>${esc(pseudo(state, id))}</span>`).join('')}</div></div>`
          : ''
      }
      ${g?.description ? `<div class="desc">${esc(g.description)}</div>` : ''}
    </div>`;
  }

  const moi = state.ranking.find((p) => p.id === me.id);
  const cases = state.rounds
    .map((r, i) => {
      const tb = r.tables.find((x) => x.playerIds.includes(me.id));
      const c = tb ? couleurJeu(state, tb.gameId) : 'var(--trait)';
      const pts = state.scores[i]?.[me.id];
      const cls = i < cr ? 'passee' : i === cr && !fini ? 'actuelle' : '';
      const info =
        i < cr || (fini && i <= cr)
          ? pts !== undefined ? `${fmtPts(pts)} pt${Math.abs(pts) > 1 ? 's' : ''}` : '<span class="doux">—</span>'
          : i === cr ? '<span class="petit">en cours</span>' : '';
      if (fini && i > cr) return '';
      return `<li class="case ${cls} ${tb && estClaire(c) ? 'claire' : ''}" style="--c:${c}">
        <span class="n num">${i + 1}</span>
        <span><span class="titre">${tb ? esc(nomJeu(state, tb.gameId)) : 'Pause'}</span>${
          tb && i >= cr && !fini ? `<span class="doux petit" style="display:block">${tb.playerIds.length} joueurs à la table</span>` : ''
        }</span>
        <span class="pts">${info}</span></li>`;
    })
    .join('');

  const choix = !fini && t ? blocChoix(t) : '';
  const score = !fini && t ? blocScore(t) : '';
  app.innerHTML = `
    ${tuile}
    ${score}
    ${choix}
    <section>
      <div class="entete"><h2>Ton parcours</h2>${moi ? `<span class="num"><strong>${fmtPts(moi.total)}</strong> <span class="doux">pts · ${moi.rank}<sup>${moi.rank === 1 ? 'er' : 'e'}</sup></span></span>` : ''}</div>
      <ol class="piste">${cases}</ol>
      ${moi?.adjustment ? `<p class="doux petit num">Dont ${moi.adjustment > 0 ? '+' : ''}${fmtPts(moi.adjustment)} pt${Math.abs(moi.adjustment) > 1 ? 's' : ''} ajouté${Math.abs(moi.adjustment) > 1 ? 's' : ''} par les organisateurs.</p>` : ''}
      ${fini ? '' : `<p class="doux petit">L'ordre peut être recalculé par les organisateurs si un jeu ou un joueur change en cours de route.</p>`}
    </section>`;
  brancherChoix();
  brancherScore();
}

// ---------------------------------------------------------------- Mon score
let brouillon = null; // { round, value } : saisie pas encore enregistrée

function blocScore(t) {
  const g = state.games.find((x) => x.id === t.gameId);
  if (g?.autoScore) return '';
  const cr = state.currentRound;
  const v = state.scores[cr]?.[me.id];
  const par = state.scoreBy?.[cr]?.[me.id];
  const statut =
    v === undefined
      ? 'Pas encore de score pour cette partie.'
      : `Enregistré : <strong class="num">${fmtPts(v)} pt${Math.abs(v) > 1 ? 's' : ''}</strong>${par === 'admin' ? ' (fixé par un organisateur)' : ''}.`;
  return `<form class="choix" id="form-score">
    <h3>Ton score à ${esc(g?.name)}</h3>
    <p class="doux petit">À la fin de la partie, entre les points que tu as gagnés. Tu peux le modifier tant que l'étape ${cr + 1} est en cours.</p>
    <div class="score-joueur">
      <button type="button" class="pas" data-pas="-1" aria-label="Retirer 1">−1</button>
      <input id="mon-score" type="number" step="any" inputmode="decimal" value="${brouillon?.round === cr ? brouillon.value : v ?? ''}" placeholder="0" aria-label="Tes points" />
      <button type="button" class="pas" data-pas="1" aria-label="Ajouter 1">+1</button>
      <button class="principal">Enregistrer</button>
    </div>
    <p class="petit" id="statut-score">${statut}${brouillon?.round === cr ? ' <span style="color:var(--rouge)">Modification pas encore enregistrée.</span>' : ''}</p>
  </form>`;
}

function brancherScore() {
  const form = document.getElementById('form-score');
  if (!form) return;
  const inp = document.getElementById('mon-score');
  const cr = state.currentRound;
  const garder = () => (brouillon = { round: cr, value: inp.value });
  inp.addEventListener('input', garder);
  form.querySelectorAll('[data-pas]').forEach(
    (b) =>
      (b.onclick = () => {
        inp.value = String(Math.round(((Number(inp.value) || 0) + Number(b.dataset.pas)) * 100) / 100);
        garder();
      })
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const v = inp.value.trim().replace(',', '.');
    const btn = form.querySelector('button.principal');
    btn.disabled = true;
    try {
      const { state: s } = await api('setMyScore', { token: me.token, points: v === '' ? null : Number(v) });
      state = s;
      brouillon = null;
      poller.setVersion(s.version);
      inp.blur();
      render();
      toast(v === '' ? 'Score effacé' : 'Score enregistré');
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  };
}

function blocCamps(t) {
  const monCamp = t.sides.findIndex((side) => side.includes(me.id));
  return `<div class="camps">${t.sides
    .map((side, i) => {
      const titre = i === monCamp ? `Ton camp (${CAMPS[i].nom.toLowerCase()})` : `Contre (camp ${CAMPS[i].nom.toLowerCase()})`;
      return `<div><div class="camp-titre" style="--c:${CAMPS[i].couleur}"><i></i>${titre}</div>
        <div class="avec">${side.map((id) => `<span>${id === me.id ? 'toi' : esc(pseudo(state, id))}</span>`).join('')}</div></div>`;
    })
    .join('')}</div>`;
}

function blocChoix(t) {
  const g = state.games.find((x) => x.id === t.gameId);
  if (!g?.choices) return '';
  const data = state.tableData[`${state.currentRound}:${g.id}`] || {};
  const blocs = Object.entries(g.choices).map(([key, c]) => {
    const cur = c.scope === 'table' ? data.table?.[key] : mesChoix[g.id]?.[key];
    const aide =
      c.scope === 'table'
        ? "N'importe qui à la table peut l'indiquer."
        : c.secret
        ? 'Reste caché aux autres joueurs jusqu’à la fin de l’étape.'
        : '';
    return `<div><h3>${esc(c.label)}</h3>${aide ? `<p class="doux petit">${aide}</p>` : ''}
      <div class="options" style="margin-top:8px">${c.options
        .map((o) => `<button data-choix="${key}" data-val="${o.value}" data-game="${g.id}" aria-pressed="${cur === o.value}">${esc(o.label)}</button>`)
        .join('')}</div></div>`;
  });
  return `<section class="choix"><p><strong>À la fin de la partie</strong>, indique ici le résultat. Les points sont calculés automatiquement.</p>${blocs.join('')}</section>`;
}

function brancherChoix() {
  app.querySelectorAll('[data-choix]').forEach((b) => {
    b.onclick = async () => {
      const deja = b.getAttribute('aria-pressed') === 'true';
      const value = deja ? null : b.dataset.val; // re-cliquer = annuler
      app.querySelectorAll(`[data-choix="${b.dataset.choix}"]`).forEach((x) => x.setAttribute('aria-pressed', 'false'));
      if (!deja) b.setAttribute('aria-pressed', 'true');
      try {
        const { state: s } = await api('tableChoice', { token: me.token, gameId: b.dataset.game, key: b.dataset.choix, value });
        state = s;
        poller.setVersion(s.version);
        await chargerMesChoix();
        render();
        toast(value ? 'C’est noté' : 'Choix effacé');
      } catch (e) {
        toast(e.message, true);
        render();
      }
    };
  });
}

function sectionClassement() {
  if (!state.ranking.length) return `<p class="vide">Personne n'est encore inscrit.</p>`;
  return `<ol class="classement">${state.ranking
    .map(
      (p) => `<li class="podium-${p.rank} ${me && p.id === me.id ? 'moi' : ''}">
        <span class="rang">${p.rank}</span><span>${esc(p.pseudo)}</span><span class="total">${fmtPts(p.total)}</span></li>`
    )
    .join('')}</ol>`;
}

function renderClassement() {
  app.innerHTML = `<section><div class="entete"><h2>Classement</h2><span class="doux petit">${
    state.status === 'finished' ? 'final' : `après ${state.currentRound} étape${state.currentRound > 1 ? 's' : ''} terminée${state.currentRound > 1 ? 's' : ''}`
  }</span></div>${sectionClassement()}</section>`;
}

function renderTables() {
  const cr = state.currentRound;
  const r = state.rounds[cr];
  app.innerHTML = `
    <section>
      <h2>Étape ${cr + 1} : qui joue où</h2>
      <div class="tables">
        ${(r?.tables || [])
          .map(
            (t) => `<div class="table" style="--c:${couleurJeu(state, t.gameId)}">
              <h3>${esc(nomJeu(state, t.gameId))}</h3>
              ${t.sides ? `<p class="doux petit">${t.sides.map((side, i) => `Camp ${CAMPS[i].nom.toLowerCase()} : ${side.map((id) => esc(pseudo(state, id))).join(', ')}`).join('<br>')}</p>` : ''}
              <div class="pions-liste">${t.playerIds
                .map((id) => `<span class="pion ${id === me.id ? 'moi' : ''}" style="--c:${couleurJeu(state, t.gameId)}"><i></i>${esc(pseudo(state, id))}</span>`)
                .join('')}</div></div>`
          )
          .join('')}
      </div>
    </section>`;
}
