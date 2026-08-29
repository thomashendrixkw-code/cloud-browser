/**
 * Page d'accueil de la session, rendue *dans* le navigateur distant.
 *
 * Elle n'est pas servie par HTTP mais injectée avec page.setContent() : aucune
 * requête réseau, aucune origine à exposer, et la barre d'adresse reste vide
 * plutôt que d'afficher une URL interne.
 *
 * Les deux fonctions exposées par Playwright font passer la saisie par la même
 * validation d'URL que la barre d'adresse, et propagent le choix du moteur à
 * toute la session.
 */
import { SEARCH_ENGINES, getEngine } from './searchEngines.js';

/** Raccourcis choisis pour leur tolérance aux navigateurs automatisés. */
const SHORTCUTS = [
  { label: 'Wikipédia', url: 'https://fr.wikipedia.org', glyph: 'W', color: '#3366cc' },
  { label: 'MDN', url: 'https://developer.mozilla.org/fr/', glyph: 'M', color: '#0b5fff' },
  { label: 'GitHub', url: 'https://github.com', glyph: 'G', color: '#24292f' },
  { label: 'Hacker News', url: 'https://news.ycombinator.com', glyph: 'Y', color: '#ff6600' },
  { label: 'OpenStreetMap', url: 'https://www.openstreetmap.org', glyph: 'O', color: '#7ebc6f' },
  { label: 'Archive.org', url: 'https://archive.org', glyph: 'A', color: '#4c6ef5' },
];

export const HOME_BINDING = '__cloudBrowserGo';
export const ENGINE_BINDING = '__cloudBrowserEngine';

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderHomePage({ engineId } = {}) {
  const engine = getEngine(engineId);

  const options = SEARCH_ENGINES.map(
    (e) => `<button class="option${e.id === engine.id ? ' on' : ''}" data-engine="${e.id}"
        data-label="${escapeHtml(e.label)}" role="menuitemradio" aria-checked="${e.id === engine.id}">
        <span class="badge" style="background:${e.color}">${escapeHtml(e.glyph)}</span>${escapeHtml(e.label)}
        <span class="check" aria-hidden="true">✓</span>
      </button>`,
  ).join('');

  const tiles = SHORTCUTS.map(
    (s) => `<button class="tile" data-url="${s.url}">
        <span class="badge lg" style="background:${s.color}">${s.glyph}</span>
        <span class="name">${escapeHtml(s.label)}</span>
      </button>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nouvel onglet</title>
<style>
  :root {
    color-scheme: light dark;
    --bg1: #f3f5fa; --bg2: #e6ecf8;
    --surface: rgba(255,255,255,.86); --edge: rgba(16,22,40,.09);
    --text: #10141c; --muted: rgba(16,20,28,.55); --accent: #0a84ff; --fill: rgba(12,18,32,.045);
    --shadow: 0 18px 50px rgba(14,20,38,.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg1: #0b0e14; --bg2: #141c2b;
      --surface: rgba(28,34,48,.8); --edge: rgba(255,255,255,.1);
      --text: #f1f4f9; --muted: rgba(241,244,249,.55); --fill: rgba(255,255,255,.07);
      --shadow: 0 18px 50px rgba(0,0,0,.5);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: 5vh 20px;
    background: radial-gradient(130% 120% at 20% -10%, var(--bg2), var(--bg1) 62%);
    color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: min(620px, 100%); text-align: center; }
  .wordmark { margin: 0 0 clamp(14px, 4vh, 34px); font-size: clamp(17px, 3.6vw, 22px); font-weight: 650; letter-spacing: -.02em; }
  .wordmark span { color: var(--muted); font-weight: 500; }

  /* Barre de recherche : sélecteur de moteur + champ + validation. */
  .searchbar {
    display: flex; align-items: center; gap: 6px; padding: 5px 5px 5px 6px;
    background: var(--surface); border: .5px solid var(--edge); border-radius: 999px; box-shadow: var(--shadow);
  }
  .engine {
    display: flex; align-items: center; gap: 7px; padding: 7px 11px 7px 8px;
    font: inherit; font-size: 13.5px; color: var(--text); background: transparent;
    border: none; border-radius: 999px; cursor: pointer; white-space: nowrap;
  }
  .engine:hover { background: var(--fill); }
  .engine .caret { font-size: 9px; color: var(--muted); }
  .divider { width: 1px; height: 22px; background: var(--edge); }
  #q {
    flex: 1; min-width: 0; padding: 10px 8px; font: inherit; font-size: 15.5px; color: var(--text);
    background: none; border: none; outline: none;
  }
  #q::placeholder { color: var(--muted); }
  .submit {
    display: grid; place-items: center; width: 38px; height: 38px; flex: 0 0 38px;
    color: #fff; background: var(--accent); border: none; border-radius: 50%; cursor: pointer;
    box-shadow: 0 3px 12px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .submit svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }

  /* Menu des moteurs */
  /* fixed, et non absolute : le menu est placé avec des coordonnées de viewport
     alors que son conteneur est centré — en absolute il partait hors champ. */
  .menu {
    position: fixed; z-index: 5; margin-top: 8px; padding: 6px; min-width: 208px;
    background: var(--surface); border: .5px solid var(--edge); border-radius: 16px; box-shadow: var(--shadow);
    text-align: left; display: none;
  }
  .menu.open { display: block; }
  .option {
    display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 10px;
    font: inherit; font-size: 13.5px; color: var(--text); background: none; border: none;
    border-radius: 11px; cursor: pointer;
  }
  .option:hover { background: var(--fill); }
  .option .check { margin-left: auto; color: var(--accent); opacity: 0; font-size: 12px; }
  .option.on .check { opacity: 1; }

  .badge {
    display: grid; place-items: center; width: 24px; height: 24px; flex: 0 0 24px;
    font-size: 11.5px; font-weight: 700; color: #fff; border-radius: 8px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.3);
  }
  .badge.lg { width: 40px; height: 40px; flex-basis: 40px; font-size: 16px; border-radius: 13px; }

  /* Raccourcis */
  .tiles {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
    gap: 10px; margin-top: clamp(18px, 5vh, 34px);
  }
  .tile {
    display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 14px 6px;
    font: inherit; color: var(--text); background: transparent; border: none; border-radius: 16px; cursor: pointer;
    transition: background .18s ease, transform .25s cubic-bezier(.22,1.15,.36,1);
  }
  .tile:hover { background: var(--fill); }
  .tile:active { transform: scale(.95); }
  .tile .name { font-size: 12.5px; color: var(--muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  footer { margin-top: clamp(18px, 5vh, 32px); font-size: 12px; color: var(--muted); }
  @media (max-height: 420px) { .tiles { display: none; } footer { display: none; } }
</style>
</head>
<body>
  <main>
    <h1 class="wordmark">Navigateur distant <span>· les sites ne voient que le serveur</span></h1>

    <form class="searchbar" id="f" autocomplete="off">
      <button class="engine" id="engine-btn" type="button" aria-haspopup="menu" aria-expanded="false">
        <span class="badge" style="background:${engine.color}">${escapeHtml(engine.glyph)}</span>
        <span id="engine-name">${escapeHtml(engine.label)}</span>
        <span class="caret">▼</span>
      </button>
      <span class="divider"></span>
      <input id="q" type="text" placeholder="Rechercher avec ${escapeHtml(engine.label)} ou saisir une adresse"
             spellcheck="false" autofocus />
      <button class="submit" type="submit" aria-label="Ouvrir">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
      </button>
    </form>

    <div class="menu" id="menu" role="menu">${options}</div>

    <div class="tiles">${tiles}</div>

    <footer>Cliquez d’abord dans la page pour prendre le contrôle du clavier.</footer>
  </main>

  <script>
    const go = (url) => { if (url && window.${HOME_BINDING}) window.${HOME_BINDING}(url); };
    const menu = document.getElementById('menu');
    const engineBtn = document.getElementById('engine-btn');

    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      go(document.getElementById('q').value.trim());
    });

    engineBtn.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      engineBtn.setAttribute('aria-expanded', String(open));
      const r = engineBtn.getBoundingClientRect();
      menu.style.left = r.left + 'px';
      menu.style.top = r.bottom + 'px';
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !engineBtn.contains(e.target)) menu.classList.remove('open');
    });

    for (const option of menu.querySelectorAll('.option')) {
      option.addEventListener('click', () => {
        const id = option.dataset.engine;
        // Mise à jour immédiate côté page : le serveur ne réinjecte pas l'accueil
        // pour ne pas effacer ce qui est déjà saisi.
        for (const other of menu.querySelectorAll('.option')) {
          other.classList.toggle('on', other === option);
          other.setAttribute('aria-checked', String(other === option));
        }
        const badge = option.querySelector('.badge');
        // Le libellé vient de data-label : textContent contiendrait aussi la
        // pastille et la coche.
        const label = option.dataset.label;
        engineBtn.querySelector('.badge').style.background = badge.style.background;
        engineBtn.querySelector('.badge').textContent = badge.textContent;
        document.getElementById('engine-name').textContent = label;
        document.getElementById('q').placeholder = 'Rechercher avec ' + label + ' ou saisir une adresse';
        menu.classList.remove('open');
        engineBtn.setAttribute('aria-expanded', 'false');
        if (window.${ENGINE_BINDING}) window.${ENGINE_BINDING}(id);
      });
    }

    for (const tile of document.querySelectorAll('.tile')) {
      tile.addEventListener('click', () => go(tile.dataset.url));
    }
  </script>
</body>
</html>`;
}

export default renderHomePage;
