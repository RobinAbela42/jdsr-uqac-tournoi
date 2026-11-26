# Tournoi JDS UQAC

Site pour gérer un tournoi de jeux de société : les joueurs s'inscrivent avec un pseudo sur leur téléphone, un algorithme calcule à quel jeu chacun joue à chaque étape, et les admins font avancer le tournoi et saisissent les points.

- **Page joueur** : `/` — inscription, jeu de l'étape en cours, **saisie de son score pour la partie en cours**, parcours complet, classement, toutes les tables.
- **Page admin** : `/admin` — jeux (bibliothèque de jeux spéciaux + jeux personnalisés), démarrer / étape suivante / précédente / terminer, points (boutons −1 / +1 ou saisie), équipes, retrait de joueurs, planning, réinitialisation.

Aucune dépendance npm : HTML/CSS/JS côté navigateur, une fonction serverless (`api/rpc.js`) et Upstash Redis via son API REST.

## Structure

```
api/rpc.js           API (une seule route : GET = état, POST = action)
lib/tournament.js    règles du tournoi et toutes les actions
lib/scheduler.js     algorithme de répartition
lib/gameTypes.js     types de jeux (point d'extension : équipes, camps, barèmes…)
lib/store.js         stockage Redis (ou mémoire en local), écritures atomiques
public/              pages joueur (index.html, app.js) et admin (admin.html, admin.js)
scripts/             serveur local + tests
```

## Lancer en local

```bash
npm run dev     # http://localhost:3000  — admin : http://localhost:3000/admin (mot de passe « admin »)
npm test        # tests de l'algo + parcours complet de l'API
```

En local sans variables Upstash, les données sont en mémoire et disparaissent quand on arrête le serveur.

## Mettre en ligne sur Vercel (gratuit)

1. Pousse ce dossier sur un dépôt GitHub.
2. Sur vercel.com : **Add New → Project**, importe le dépôt, et nomme le projet **`jds-uqac`**. L'adresse sera `https://jds-uqac.vercel.app` si le nom est libre ; sinon Vercel ajoute un suffixe, et tu peux changer le domaine `.vercel.app` dans *Settings → Domains*. Framework preset : **Other**, aucune commande de build.
3. Dans le projet : **Storage → Create Database → Upstash for Redis** (offre gratuite), puis connecte-la au projet. Ça ajoute automatiquement `KV_REST_API_URL` et `KV_REST_API_TOKEN`.
4. **Settings → Environment Variables** : ajoute `ADMIN_PASSWORD` avec le mot de passe des admins.
5. **Redeploy** (les variables ne sont prises en compte qu'au déploiement suivant).

Sans `ADMIN_PASSWORD`, l'admin est bloqué en production. Sans Redis, la page admin affiche un avertissement rouge.

## Comment marche l'algorithme

**Contraintes strictes (jamais violées)**
- Une table est soit vide, soit entre son minimum et son maximum de joueurs. Une partie de Secret Hitler (5 à 10) ne sera jamais lancée à 4.
- Un maximum de joueurs est placé à chaque étape. Si les minimums rendent impossible de placer tout le monde (ex. 9 joueurs avec uniquement des jeux de exactement 4 places), les joueurs en trop sont **en pause**, à tour de rôle, et leur nombre est le plus petit possible. L'admin est prévenu avant de démarrer.

**Ce qui est optimisé ensuite**

| Situation | Pénalité |
|---|---|
| rejouer à un jeu déjà joué | forte, et croissante (×1, ×5, ×14…) |
| même jeu deux étapes de suite | moyenne |
| retrouver quelqu'un déjà rencontré | croissante avec le nombre de rencontres |
| être en pause plusieurs fois | croissante (on fait tourner qui attend) |
| règles propres au type de jeu | définies dans `gameTypes.js` (équipes, camps…) |

Un joueur peut ne jamais jouer à un jeu si les places ne le permettent pas : l'objectif est surtout qu'il joue à des jeux différents le plus longtemps possible.

**Fonctionnement**
1. Pour chaque étape, l'algo calcule les « formes » possibles : combien de joueurs à chaque table, en respectant min et max (par ex. avec 8 joueurs : 8 sur Secret Hitler, ou 4 + 4 sur deux autres jeux). Il en tire plusieurs au hasard, remplit chacune et garde la meilleure.
2. Il améliore ensuite toutes les étapes ensemble par recuit simulé. Les mouvements possibles :
   - échanges de joueurs ;
   - déplacements d'équipes ;
   - échanges croisés entre deux étapes ;
   - changements de forme d'une étape (passer de « 4 + 4 » à « 8 sur un seul jeu »).

   Tout mouvement qui casserait un minimum est refusé.

Le calcul dure au maximum environ 2,5 s. Les poids sont dans `WEIGHTS` en haut de `lib/scheduler.js`.

Le nombre d'étapes calculées au départ tient compte du nombre de tables qui peuvent tourner en même temps. Avec des minimums élevés, il faut parfois plus d'étapes que de jeux pour que tout le monde passe partout. Si les admins dépassent la dernière étape prévue, la suite se calcule automatiquement.

Règles importantes :
- Une inscription est refusée si le nombre de joueurs atteint le total des places.
- Les inscriptions se ferment au démarrage. Un admin peut les rouvrir : chaque nouvel arrivant recalcule alors les étapes à venir.
- Modifier les places ou le type d'un jeu, ajouter ou supprimer un jeu, ou retirer un joueur pendant le tournoi recalcule **uniquement les étapes à venir**. L'étape en cours et les étapes passées ne bougent jamais.

## Bibliothèque de jeux spéciaux

Dans l'admin, la section « Bibliothèque de jeux spéciaux » ajoute un jeu au tournoi en un clic ; « Retirer » l'enlève. Les réglages (places, points…) se modifient ensuite avec « Modifier ».

**Codenames**
- Tant que Codenames est dans le tournoi, chaque joueur peut, avant le début, faire équipe avec d'autres depuis son téléphone (« Faire équipe » / « Rejoindre » / « Quitter l'équipe »). Taille max : la moitié des places (6 places → 3).
- Quand une équipe tombe sur Codenames, elle y va au complet, à la même étape, et reste dans le même camp.
- Les camps (rouge / bleu) sont équilibrés : une équipe de 3 joue contre une équipe de 3, ou une équipe de 2 + 1 joueur seul, etc. Les joueurs sans équipe complètent au hasard.
- Les équipes sont verrouillées au démarrage. L'admin peut encore retirer quelqu'un d'une équipe (les étapes à venir sont alors recalculées).

**Secret Hitler**
- Pendant l'étape, chaque joueur de la table indique son rôle (libéral, fasciste, Hitler) sur son téléphone, et n'importe qui à la table indique le camp gagnant. Les rôles restent cachés aux autres joueurs jusqu'à la fin de l'étape.
- Au passage à l'étape suivante (ou à la fin du tournoi), les points sont attribués automatiquement selon le barème réglé dans l'admin : points par rôle si son camp gagne / si son camp perd. On peut aussi décocher « Les points dépendent du camp gagnant » pour ne compter que le rôle.
- L'admin voit et peut corriger les rôles et le camp gagnant dans la section Points ; corriger une étape passée recalcule ses points. Un score saisi à la main par l'admin n'est jamais écrasé par le calcul automatique (pastille « auto » = calculé).
- Si un rôle ou le camp gagnant manque, l'admin reçoit un avertissement au passage à l'étape suivante.

## Points

- **Les joueurs entrent leur score** depuis leur téléphone pendant l'étape (−1 / +1 ou saisie, puis « Enregistrer »). Le score est rattaché à l'étape ; une fois l'étape passée, il ne peut plus être modifié par le joueur. Pour les jeux à calcul automatique (Secret Hitler), il n'y a pas de saisie : les rôles suffisent.
- **Section Points (admin)** : uniquement l'étape en cours, pour compléter ou corriger. Pastille « joueur » = entré par le joueur, « auto » = calculé. Une saisie de l'admin ou du joueur n'est jamais écrasée par le calcul automatique.
- **Section Joueurs (admin)** : −1 / +1 / ± sur chaque joueur, à tout moment, pour ajouter ou retirer des points directement au total (bonus, pénalité, correction d'une étape passée). Le joueur voit « dont +X ajoutés par les organisateurs ».
- Toutes ces opérations sont atomiques côté serveur : plusieurs personnes peuvent cliquer en même temps sans perdre de points.

### Ajouter un nouveau jeu spécial

Tout se passe dans `lib/gameTypes.js` : un type de jeu est un objet avec des hooks facultatifs (`preset`, `configFields`, `teams`, `tableCost`, `decorateTable`, `choices`, `scoreTable`), documentés en haut du fichier. Codenames et Secret Hitler servent d'exemples. On l'ajoute à `GAME_TYPES` et il apparaît dans la bibliothèque ; l'algorithme, l'API et les pages s'adaptent tout seuls (choix à la table, camps, réglages admin).

## Sécurité

- Le mot de passe admin est envoyé dans l'en-tête `x-admin-password` (HTTPS sur Vercel) et gardé dans la session du navigateur.
- Chaque joueur reçoit un jeton secret stocké sur son téléphone (`localStorage`). Il n'est jamais renvoyé aux autres.
- Toutes les écritures passent par un compare-and-set atomique dans Redis, donc des inscriptions simultanées ne s'écrasent pas.
