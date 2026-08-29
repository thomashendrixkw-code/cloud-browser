# Contribuer

## Mise en route

```bash
npm install     # installe aussi Chromium
npm run dev     # rechargement à chaud
npm test        # test de bout en bout, sans réseau externe
```

Node 20 ou plus. Le test démarre le serveur, sert une page locale, ouvre une
session réelle et vérifie le rendu, les interactions, la validation d'URL et le
cycle de vie. Il doit rester **hermétique** : aucun site externe, sinon la
suite devient dépendante d'Internet et des protections anti-bot.

## Repères

| Sujet | Fichier |
|---|---|
| Configuration, détection Codespaces | `src/config.js` |
| Instance Chromium partagée, rotation | `src/browser/browserManager.js` |
| Sessions, entrées, régulateur de qualité | `src/browser/session.js` |
| Les deux modes de streaming | `src/streaming/` |
| Protocole temps réel | `src/ws/wsServer.js` |
| Interface | `public/` |

## Style

Pas de linter imposé : suivez le style du fichier que vous modifiez —
2 espaces, point-virgules, modules ES, commentaires en français expliquant le
*pourquoi* plutôt que le *quoi*.

Quelques invariants à ne pas casser :

- toute action Playwright passe par `withTimeout` ;
- toute URL saisie passe par `validateUrl` (protocoles et anti-SSRF) ;
- les frames sont abandonnées, jamais mises en file, quand le lien sature ;
- ce qui se configure vit dans le panneau « Paramètres », pas ailleurs.

## Proposer un changement

Ouvrez une issue pour discuter d'un changement d'architecture. Pour un correctif,
une pull request avec `npm test` au vert suffit.
