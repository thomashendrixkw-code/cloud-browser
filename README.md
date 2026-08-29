<img src="public/icon.svg" width="76" align="right" alt="" />

# Cloud Browser

[![CI](https://github.com/thomashendrixkw-code/cloud-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/thomashendrixkw-code/cloud-browser/actions/workflows/ci.yml)
[![Licence MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

Un navigateur Chromium tourne **sur le serveur** ; vous ne recevez que des images
JPEG de la page et vos clics, frappes et scrolls y sont rejoués. Le site visité
ne voit jamais votre IP : il ne voit que celle de la machine qui exécute ce
projet.

Prévu pour **1 à 3 sessions simultanées** — un usage personnel, pas un service.

![Un article Wikipédia affiché dans le navigateur distant](docs/navigation.png)

**Sommaire** — [Démarrage](#démarrage) · [Conçu pour le tunnel Codespaces](#conçu-pour-le-tunnel-codespaces) ·
[Utilisation](#utilisation) · [Comment ça marche](#comment-ça-marche) ·
[Accès et sécurité](#accès-et-sécurité) · [Configuration](#configuration) ·
[API](#api) · [Dépannage](#dépannage) · [Limites connues](#limites-connues)

---

## Démarrage

### Dans un GitHub Codespace (cible principale)

**1.** *Code → Codespaces → Create codespace on main.* Le conteneur part de
l'image officielle Playwright : Chromium et ses dépendances système y sont déjà.

**2.** Dans le terminal du Codespace, installez les dépendances Node :

```bash
npm install
```

Quelques secondes seulement : le navigateur étant déjà présent dans l'image,
il n'y a que trois paquets à récupérer.

**3.** Démarrez le serveur :

```bash
npm start
```

**4.** VS Code propose alors d'ouvrir le port **8787** — soit par la
notification, soit par l'onglet **Ports**. L'adresse ressemble à
`https://<nom-du-codespace>-8787.app.github.dev` et n'est accessible qu'à votre
compte GitHub.

> **Pourquoi ces deux commandes ne sont pas automatiques.** Le
> `devcontainer.json` ne déclare volontairement aucune commande de cycle de vie.
> Une installation qui échoue en arrière-plan est plus déroutante que deux
> commandes explicites, et un serveur démarré tout seul entre en collision avec
> celui que vous lancez ensuite. Vous voyez ce qui se passe, et les erreurs
> s'affichent devant vous.

**Machine :** 2 cœurs suffisent à démarrer, 4 rendent le flux nettement plus
fluide — l'encodage JPEG de chaque image est le poste de calcul dominant.

**Et le réglage qui pèse le plus lourd n'est pas dans ce dépôt** : c'est la
*région* de votre Codespace (GitHub → Settings → Codespaces → Default region).
Le trajet navigateur → périphérie GitHub → machine virtuelle domine tout le
reste ; une région proche de vous vaut tous les réglages de qualité réunis.

### En local

```bash
npm install     # installe aussi Chromium (~150 Mo, une seule fois)
npm start       # http://localhost:8787
```

Node 20 ou plus. Aucune configuration n'est nécessaire : sans `.env`, le serveur
écoute uniquement sur `127.0.0.1` et n'est donc joignable que depuis votre
machine. En développement, `npm run dev` relance le serveur à chaque
modification ; `npm test` lance la suite de bout en bout.

---

## Conçu pour le tunnel Codespaces

Le rendu ne voyage pas sur un réseau local : il passe par le tunnel HTTPS de
GitHub, avec un aller-retour qui se compte en dizaines ou centaines de
millisecondes. Cela change ce qu'il faut optimiser — envoyer *plus* de qualité
ne sert à rien si les images finissent par faire la queue devant les clics.

**Régulateur de qualité piloté par la latence.** Le client mesure son
aller-retour chaque seconde et le renvoie au serveur. Le signal utile n'est pas
le débit brut mais le *gonflement* du temps d'aller-retour par rapport à son
minimum observé : quand les images saturent le trajet, elles retardent les
interactions. Le serveur descend alors vite (−12 de qualité, au plus toutes les
700 ms) et remonte lentement (+4, au plus toutes les 2,5 s), entre
`MIN_JPEG_QUALITY` et `MAX_JPEG_QUALITY`. Sur un lien qui respire, la qualité
monte jusqu'au plafond toute seule ; sur un lien saturé, elle cède du terrain
pour garder la main réactive. Désactivable dans **Paramètres → Image**.

**Les interactions ne font plus la queue derrière les navigations.** Les
messages entrants passaient tous par une même file : un `goto` de trois
secondes retardait d'autant les clics suivants. Les entrées (souris, clavier,
molette) ont désormais leur propre file.

**Nagle désactivé** (`setNoDelay`) sur la connexion : sans cela, le système
regroupe les petits paquets et ajoute jusqu'à 40 ms à chaque clic ou frappe.

**Images en binaire**, jamais en base64 ; seule la plus récente est décodée
côté client ; une image est abandonnée plutôt que mise en file quand le tampon
dépasse 1 Mo. Chaque frame CDP est acquittée même lorsqu'elle n'est pas
transmise, sinon Chromium cesse d'émettre.

**Rendu réglé pour la compression.** Chromium tourne avec
`--force-color-profile=srgb`, `--disable-lcd-text` et
`--font-render-hinting=none` : l'anticrénelage en niveaux de gris compresse
mieux que le sous-pixel et évite les franges colorées sur le texte, ce qui rend
les lettres plus propres à qualité JPEG égale.

**Détection automatique du Codespace.** Le sandbox Chromium est désactivé (il
n'existe pas dans ce conteneur), la qualité de départ passe à 78, et l'URL
publique du port est affichée au démarrage :

```
[INFO] [server] Codespace détecté — accès via https://<nom>-8787.app.github.dev
```

Le port reste transmis par le tunnel privé de GitHub : seul votre compte y
accède, et le serveur n'écoute que sur `127.0.0.1` — c'est le transmetteur de
GitHub qui s'y connecte. Une authentification applicative n'est donc pas
nécessaire dans ce cadre (§ *Accès et sécurité* pour l'exposer autrement).

### Ce que ce projet ne fera pas disparaître

Le tunnel ajoute un saut, et le JPEG plein cadre reste le format de transport :
chaque changement visuel réexpédie l'image entière. Diviser encore la latence
demanderait un encodage vidéo (WebRTC/VP8) ou un envoi par tuiles modifiées —
un autre projet. Enfin, `Page.startScreencast` capture en pixels CSS : la
**netteté ×2 n'est donc possible que dans les modes polling**, où le rendu passe
par une capture d'écran classique.

---

## Utilisation

**Au premier lancement**, une introduction en trois écrans présente le principe
et fait choisir l'essentiel : moteur de recherche, et compromis entre réactivité
et finesse d'image. Elle ne réapparaît plus ensuite — tout ce qu'elle règle
reste modifiable dans **Paramètres**, où un bouton permet aussi de la revoir.

<p align="center">
  <img src="docs/introduction.png" width="49%" alt="Introduction au premier lancement" />
  <img src="docs/parametres.png" width="49%" alt="Panneau Paramètres" />
</p>

À l'ouverture d'une session, le navigateur distant affiche une **page d'accueil**
à la manière d'un nouvel onglet : barre de recherche avec sélecteur de moteur
intégré, et raccourcis vers quelques sites. Elle est injectée directement dans
la page (`setContent`), sans requête réseau ni origine exposée : la barre
d'adresse reste donc vide plutôt que d'afficher une URL interne. Le bouton
maison y ramène à tout moment, et `HOME_URL` la remplace par le site de votre
choix.

![Page d'accueil du navigateur distant](docs/accueil.png)

**Le moteur de recherche** (Google, DuckDuckGo, Bing, Qwant, Brave, Ecosia) vaut
partout : page d'accueil *et* barre d'adresse de l'application partagent la même
normalisation. On le change aux deux endroits — depuis le sélecteur de la page
d'accueil ou depuis Paramètres — et les deux restent synchronisés.

Saisissez une URL (`example.com`) ou une recherche, ici ou dans la barre
d'adresse. Une fois la page affichée, **cliquez dans la zone de rendu pour
prendre le contrôle** : clics, molette, clavier, copier-coller sont transmis à
la page distante.

| Raccourci | Effet |
|---|---|
| `Alt` + `←` / `→` | précédent / suivant |
| `F5` ou `Ctrl/Cmd` + `R` | recharger |
| `Ctrl/Cmd` + `L` | revenir à la barre d'adresse |

Tout ce qui se règle vit dans le panneau **Paramètres** (icône à droite de la
barre d'adresse), et nulle part ailleurs :

| Section | Réglages |
|---|---|
| **Recherche** | moteur par défaut, utilisé par l'accueil et la barre d'adresse |
| **Flux** | screencast CDP, polling WebSocket ou polling HTTP |
| **Image** | qualité adaptative ou fixe, cadence du polling, netteté HiDPI ×2 (modes polling) |
| **Fenêtre distante** | ajustement automatique à l'affichage, ou taille fixe |
| **Affichage** | halo ambiant, mesures de débit, lissage de l'image |
| **Session** | compte, identifiant, fenêtre, débit ; nouvelle session, déconnexion, revoir l'introduction |

Les préférences sont mémorisées dans le navigateur et réappliquées à la
reconnexion. Les réglages qui engagent le serveur entier (nombre de sessions,
délai d'inactivité, rotation de Chromium) restent dans `.env`.

L'interface est en **Liquid Glass** : la barre, la pastille d'état et le
panneau sont des surfaces translucides qui réfractent un halo calculé à partir
de la page distante — le « Halo ambiant » du panneau le désactive.

---

## Comment ça marche

**Un seul Chromium, un contexte par utilisateur.** Le process Chromium est lancé
une fois et partagé ; chaque session reçoit un `BrowserContext` isolé (cookies,
localStorage, cache séparés). C'est ce qui permet de tenir plusieurs sessions
dans peu de RAM. Toutes les `BROWSER_RESTART_HOURS`, le process est renouvelé
sans couper les sessions en cours : l'ancienne instance passe en drainage et se
ferme quand son dernier contexte est libéré.

**Deux approches de streaming**, commutables à chaud depuis l'interface :

| | Screencast CDP | Polling de captures |
|---|---|---|
| Mécanisme | `Page.startScreencast` pousse une frame à chaque changement visuel | `page.screenshot()` toutes les 250 ms |
| Trafic | quasi nul sur une page statique | constant |
| Latence | ~50–150 ms | 250 ms + temps de capture |
| Robustesse | dépend du CDP | fonctionne toujours |

Chaque frame CDP est acquittée (`Page.screencastFrameAck`) même quand elle n'est
pas transmise : sans cet accusé Chromium cesse d'émettre, et c'est aussi ce qui
empêche la connexion de se noyer. Si le CDP échoue, la session bascule seule en
polling. L'interface propose en plus le polling via HTTP
(`GET /api/session/:id/screenshot`), qui n'utilise pas le WebSocket pour le
rendu.

**Contrôle de flux.** Une frame est abandonnée — jamais mise en file — si le
tampon du WebSocket dépasse 1 Mo, et le client ne décode que la frame la plus
récente. Une connexion lente dégrade la fluidité, pas la fraîcheur de l'image.

**Coordonnées normalisées.** Le client envoie des positions `[0,1]` que le
serveur multiplie par la taille du viewport distant : l'affichage peut être
redimensionné sans jamais désaligner les clics.

**Garde-fous.** Toute action Playwright est sous timeout, les URL sont validées
(http/https uniquement, IP privées et métadonnées cloud refusées), les
téléchargements sont bloqués, les dialogues natifs fermés automatiquement, et
les sessions inactives libérées au bout de `SESSION_IDLE_MINUTES`.

---

## Accès et sécurité

Un navigateur distant joignable par tous **est un proxy ouvert** : n'importe qui
navigue alors avec l'IP de votre machine, et le trafic vous est imputé.

Le serveur applique donc une règle simple :

- **aucun identifiant configuré** → écoute forcée sur `127.0.0.1`, quel que soit
  `HOST`. Utilisable immédiatement, impossible à exposer par inadvertance ;
- **`ACCESS_PASSWORD` (ou `AUTH_USERS`) défini** → page de connexion, cookie
  signé HMAC (`HttpOnly`, `SameSite=Lax`), et `HOST` est respecté.

Quand l'authentification est active : chaque session appartient à son créateur
(une session qui n'est pas la vôtre répond `404`, y compris à l'ouverture du
WebSocket), la connexion est limitée à 10 tentatives par quart d'heure, les
comparaisons de secrets sont à temps constant, et `/api/health` ne dit rien de
plus que `{ status, uptimeSec }` à un anonyme.

Pour exposer le service :

```bash
# dans .env
ACCESS_PASSWORD=un-mot-de-passe-solide
AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
HOST=0.0.0.0
AUTH_SECURE_COOKIE=true   # si vous êtes derrière HTTPS
```

`ALLOW_UNAUTHENTICATED_EXPOSURE=true` lève le garde-fou sans authentification.
Ne l'utilisez que sur un réseau que vous maîtrisez entièrement.

Ce que cela ne couvre pas : l'IP de sortie reste la vôtre, les identifiants sont
en clair dans `.env` (`chmod 600`), et il n'y a pas de révocation individuelle —
changer `AUTH_SECRET` invalide tous les jetons d'un coup.

---

## Configuration

Tout est facultatif ; voir `.env.example` pour la liste complète.

| Variable | Défaut | Effet |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | écoute (voir *Accès et sécurité*) |
| `ACCESS_PASSWORD` | *(vide)* | active l'authentification et autorise `HOST` |
| `AUTH_USERS` | *(vide)* | plusieurs comptes : `"alice:mdp,bob:autre"` |
| `MAX_SESSIONS` | `3` | refus en `503` au-delà |
| `MAX_SESSIONS_PER_USER` | `0` | quota par compte (`0` = aucun), refus en `429` |
| `SESSION_IDLE_MINUTES` | `10` | fermeture automatique d'une session inactive |
| `STREAM_MODE` | `screencast` | `screencast` ou `poll` |
| `JPEG_QUALITY` | `60` (`78` en Codespace) | qualité de départ |
| `ADAPTIVE_QUALITY` | `true` | régulation de la qualité par la latence mesurée |
| `MIN_JPEG_QUALITY` / `MAX_JPEG_QUALITY` | `35` / `88` | bornes du régulateur |
| `TARGET_LATENCY_MS` | `180` | gonflement d'aller-retour toléré avant de céder de la qualité |
| `VIEWPORT_WIDTH/HEIGHT` | `1280×720` | taille de la fenêtre distante |
| `HOME_URL` | *(vide)* | remplace la page d'accueil intégrée |
| `SEARCH_ENGINE` | `duckduckgo` | moteur par défaut des nouvelles sessions |
| `BROWSER_RESTART_HOURS` | `8` | rotation du process Chromium |
| `CHROMIUM_SANDBOX` | `true` (`false` en Codespace) | ne désactiver qu'en conteneur |

---

## API

Les routes `/api/session*` exigent le cookie d'authentification quand elle est
active, et n'agissent que sur vos propres sessions.

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/api/session` | crée une session — `{ deviceScaleFactor, searchEngine }` optionnels (`503` si la limite est atteinte) |
| `GET` · `DELETE` | `/api/session/:id` | état · fermeture |
| `POST` | `/api/session/:id/navigate` | `{ "url": "google.com" }` |
| `POST` | `/api/session/:id/back` · `/forward` · `/reload` · `/home` | historique et accueil |
| `GET` | `/api/session/:id/screenshot` | capture JPEG à la demande |
| `POST` | `/api/session/:id/mode` | `{ "mode": "screencast" \| "poll" }` |
| `POST` | `/api/auth/login` · `/logout` · `GET /me` | authentification |
| `GET` | `/api/engines` | catalogue des moteurs de recherche |
| `GET` | `/api/health` | état du serveur (détaillé si authentifié) |

**WebSocket `/ws?sessionId=…`** — le serveur envoie les frames JPEG en binaire
et l'état en JSON ; le client envoie ses interactions :

```jsonc
{ "type": "navigate", "url": "google.com" }
{ "type": "home" }
{ "type": "mouse", "action": "down|up|move|click", "x": 0.5, "y": 0.4, "button": 0 }
{ "type": "wheel", "x": 0.5, "y": 0.5, "deltaY": 400 }
{ "type": "key", "action": "down|up", "key": "Enter" }
{ "type": "text", "text": "collage, accents, émojis" }
{ "type": "mode", "mode": "screencast|poll" }
{ "type": "settings", "jpegQuality": 60, "pollIntervalMs": 250, "adaptive": true, "searchEngine": "qwant" }
{ "type": "telemetry", "rtt": 120, "backlog": 0 }
{ "type": "viewport", "width": 1280, "height": 720 }
```

---

## Dépannage

**Le port est déjà utilisé.** Le serveur le dit et propose une alternative :
`PORT=8788 npm start`. Une instance oubliée dans un autre terminal est la cause
la plus fréquente.

**La page s'affiche mais reste figée, ou le flux ne démarre pas.** Vérifiez que
le port n'est pas intercepté par un agent local. Le **8080 est le port proxy par
excellence** : sur certaines machines, un service s'y intercale et casse le
WebSocket (`Invalid WebSocket frame: RSV1 must be clear`). C'est la raison pour
laquelle le port par défaut est 8787 ; si vous l'avez changé, essayez-en un
autre avant de chercher plus loin.

**`Executable doesn't exist` au lancement de Chromium.** L'installation du
navigateur n'a pas eu lieu : `npx playwright install chromium`. En conteneur,
ajoutez `--with-deps` pour les bibliothèques système.

**`Failed to launch` ou plantage immédiat en conteneur.** Le sandbox Chromium
n'y est pas disponible : `CHROMIUM_SANDBOX=false` (déjà réglé dans le
devcontainer). Ne le désactivez pas sur une machine exposée.

**`503` à l'ouverture d'une session.** La limite de sessions simultanées est
atteinte (`MAX_SESSIONS`, 3 par défaut). Les sessions inactives se ferment
d'elles-mêmes au bout de `SESSION_IDLE_MINUTES` ; l'interface réessaie seule.

**Le site affiche un blocage ou un CAPTCHA.** C'est la limite décrite plus bas :
certains sites reconnaissent un navigateur automatisé. Les CAPTCHA visibles
restent résolvables à la main, les challenges invisibles non.

**L'image est nette mais saccadée.** Le régulateur a probablement baissé la
qualité pour protéger la latence — c'est le comportement voulu sur un lien
chargé. Pour figer un compromis, désactivez « Qualité adaptative » dans
Paramètres. Pour diagnostiquer, activez « Afficher les mesures » : la latence
affichée est celle du trajet réel.

**Rien ne s'affiche dans un Codespace.** Assurez-vous que `npm start` tourne
toujours dans le terminal, puis ouvrez le port 8787 depuis l'onglet **Ports**.
Le tunnel est privé : une session GitHub différente n'y a pas accès.

---

## Limites connues

**Détection anti-bot.** C'est la limite la plus visible. Cloudflare, DataDome et
consorts reconnaissent un Chromium piloté et servent un challenge ou un blocage
sec ; Google affiche souvent un reCAPTCHA ; DuckDuckGo bloque
`html.duckduckgo.com` en navigation automatisée. Les CAPTCHA visibles restent
résolvables à la main puisque clics et clavier passent — pas les challenges
invisibles. Les sites ordinaires (documentation, presse, wikis) fonctionnent
sans souci.

**Latence.** ~50–150 ms en screencast sur une machine proche, plus la latence
réelle du site. La saisie reste confortable ; le scroll fluide, le drag précis
et la vidéo ne le sont pas — chaque changement visuel est une image à
retransmettre.

**Mémoire.** ~150–250 Mo par session, davantage sur les applications web lourdes
(Gmail, Maps). La rotation périodique de Chromium évite la dérive sur la durée,
pas un site qui fuit dans l'instant.

**Sessions non persistantes.** Les cookies vivent dans le `BrowserContext`, donc
en RAM : à la fermeture de la session (inactivité, redémarrage), tout est perdu
et il faut se reconnecter aux sites. Rien n'est écrit sur disque, par choix.
Le point d'accroche si vous en avez besoin : `context.storageState()` à la
fermeture, `newContext({ storageState })` à la création — en chiffrant le
fichier.

**Divers.** Les téléchargements sont bloqués, le son n'est pas transmis, et le
multi-onglets n'est pas exposé : un pop-up devient la page affichée, et sa
fermeture ramène à la précédente.

---

## Structure

```
.devcontainer/devcontainer.json   image Playwright, port 8787, sandbox désactivé
public/                           interface Liquid Glass : index.html, login.html, app.js, styles.css
src/
├── index.js                      Express + HTTP + WebSocket + arrêt propre
├── config.js                     configuration (.env facultatif, sans dépendance)
├── logger.js
├── auth/token.js                 jeton signé HMAC, comparaisons à temps constant
├── browser/
│   ├── homePage.js               page d'accueil injectée dans le navigateur distant
│   ├── searchEngines.js          catalogue des moteurs et gabarits de recherche
│   ├── browserManager.js         Chromium partagé + rotation périodique
│   ├── sessionPool.js            sessions actives, limites, purge d'inactivité
│   └── session.js                contexte + page + interactions + navigation
├── streaming/
│   ├── screencast.js             CDP Page.startScreencast
│   └── poller.js                 captures périodiques
├── http/
│   ├── routes.js                 API REST
│   └── auth.js                   comptes, connexion, politique d'exposition
├── ws/wsServer.js                transport temps réel + backpressure
└── util/                         url.js (validation), rateLimit.js, withTimeout.js
```

Trois dépendances : `express`, `ws`, `playwright`.

---

## Contribuer

Le fonctionnement, les repères de code et les invariants à ne pas casser sont
dans [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` lance une suite de bout en
bout hermétique : elle démarre le serveur, sert une page locale et vérifie le
rendu, les interactions, la validation d'URL et le cycle de vie des sessions.

## Licence

[MIT](LICENSE) — © 2026 Thomas Hendrickx.
