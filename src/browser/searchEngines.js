/**
 * Moteurs de recherche proposés. Le choix vaut partout : page d'accueil
 * *et* barre d'adresse de l'application, qui partagent la même normalisation.
 */
export const SEARCH_ENGINES = [
  { id: 'google', label: 'Google', search: 'https://www.google.com/search?q=%s', glyph: 'G', color: '#4285f4' },
  { id: 'duckduckgo', label: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=%s', glyph: 'D', color: '#de5833' },
  { id: 'bing', label: 'Bing', search: 'https://www.bing.com/search?q=%s', glyph: 'B', color: '#008373' },
  { id: 'qwant', label: 'Qwant', search: 'https://www.qwant.com/?q=%s', glyph: 'Q', color: '#5c5cff' },
  { id: 'brave', label: 'Brave', search: 'https://search.brave.com/search?q=%s', glyph: 'Br', color: '#fb542b' },
  { id: 'ecosia', label: 'Ecosia', search: 'https://www.ecosia.org/search?q=%s', glyph: 'E', color: '#0f8a5f' },
];

export const DEFAULT_ENGINE_ID = 'duckduckgo';

export function getEngine(id) {
  return SEARCH_ENGINES.find((engine) => engine.id === id) ?? SEARCH_ENGINES.find((e) => e.id === DEFAULT_ENGINE_ID);
}

/** Liste allégée pour le client (pas de gabarit d'URL à exposer). */
export function publicEngines() {
  return SEARCH_ENGINES.map(({ id, label, glyph, color }) => ({ id, label, glyph, color }));
}

export default SEARCH_ENGINES;
