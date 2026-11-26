// Point d'entrée unique de l'API (fonction serverless Vercel).
//   GET  /api/rpc                      -> état public du tournoi
//   POST /api/rpc  { action, ...params } -> exécute une action
// Les actions admin demandent l'en-tête  x-admin-password.
import { readState, updateState, storeKind } from '../lib/store.js';
import { ACTIONS, initialState, publicState, UserError } from '../lib/tournament.js';

const isProd = !!process.env.VERCEL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isProd ? '' : 'admin');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  try {
    const isAdmin = !!ADMIN_PASSWORD && req.headers['x-admin-password'] === ADMIN_PASSWORD;
    if (req.method === 'GET') {
      const { state, version } = await readState(initialState);
      return send(res, 200, { ...publicState(state, version, { admin: isAdmin }), storeKind });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Méthode non autorisée' });

    const body = await readBody(req);
    const action = ACTIONS[body.action];
    if (!action) return send(res, 400, { error: 'Action inconnue' });

    if (action.admin) {
      if (!ADMIN_PASSWORD)
        return send(res, 500, { error: "ADMIN_PASSWORD n'est pas configuré sur le serveur." });
      if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
        return send(res, 401, { error: 'Mot de passe admin incorrect.' });
    }

    if (action.readOnly) {
      const { state, version } = await readState(initialState);
      const result = await action.run(state, body);
      return send(res, 200, { result, state: publicState(state, version, { admin: isAdmin }) });
    }

    const { state, result, version } = await updateState(initialState, (s) => {
      const r = action.run(s, body);
      s.updatedAt = Date.now();
      return r;
    });
    return send(res, 200, { result, state: publicState(state, version, { admin: isAdmin }) });
  } catch (e) {
    if (e instanceof UserError) return send(res, 400, { error: e.message });
    if (e instanceof SyntaxError) return send(res, 400, { error: 'Requête invalide.' });
    console.error(e);
    return send(res, 500, { error: 'Erreur serveur : ' + e.message });
  }
}
