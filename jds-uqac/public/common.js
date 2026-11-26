// Outils partagés par la page joueur et la page admin.

export const COULEURS = ['#e2463b', '#2f6fd6', '#f3b622', '#2e9e6a', '#7b5bd6', '#f07f2b', '#d6457f', '#1f9bb0'];
const CLAIRES = new Set(['#f3b622']); // couleurs sur lesquelles le texte doit être foncé

export function couleurJeu(state, gameId) {
  const i = state.games.findIndex((g) => g.id === gameId);
  return COULEURS[(i < 0 ? 0 : i) % COULEURS.length];
}
export const estClaire = (c) => CLAIRES.has(c);

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const fmtPts = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')).replace('.', ',');

export async function api(action, params = {}, adminPassword) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminPassword) headers['x-admin-password'] = adminPassword;
  let res;
  try {
    res = await fetch('/api/rpc', { method: 'POST', headers, body: JSON.stringify({ action, ...params }) });
  } catch {
    throw new Error('Connexion impossible. Vérifie ton réseau.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Erreur ' + res.status), { status: res.status });
  return data;
}

export async function fetchState(adminPassword) {
  const headers = adminPassword ? { 'x-admin-password': adminPassword } : {};
  const res = await fetch('/api/rpc', { cache: 'no-store', headers });
  if (!res.ok) throw new Error('Serveur indisponible');
  return res.json();
}

// Rafraîchit l'état toutes les `ms` millisecondes (pause quand l'onglet est caché).
export function poll(onState, ms = 4000, adminPassword) {
  let timer;
  let last = -1;
  async function tick(force) {
    clearTimeout(timer);
    try {
      const s = await fetchState(adminPassword);
      if (force || s.version !== last) {
        last = s.version;
        onState(s);
      }
    } catch (e) {
      console.warn(e);
    }
    if (!document.hidden) timer = setTimeout(tick, ms);
  }
  document.addEventListener('visibilitychange', () => !document.hidden && tick());
  tick(true);
  return { refresh: () => tick(true), setVersion: (v) => (last = v) };
}

let toastTimer;
export function toast(msg, isErr = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

export function tableDe(state, roundIndex, playerId) {
  return state.rounds[roundIndex]?.tables.find((t) => t.playerIds.includes(playerId)) || null;
}

export const nomJeu = (state, id) => state.games.find((g) => g.id === id)?.name ?? '?';
export const pseudo = (state, id) => state.players.find((p) => p.id === id)?.pseudo ?? '?';

export const typeDe = (state, game) => state.gameTypes.find((t) => t.id === game?.type);
export const CAMPS = [
  { nom: 'Rouge', couleur: '#e2463b' },
  { nom: 'Bleu', couleur: '#2f6fd6' },
];
