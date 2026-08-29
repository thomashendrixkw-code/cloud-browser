/**
 * Cloud Browser — client.
 *
 * Reçoit des frames JPEG (binaire sur WebSocket, ou HTTP en mode polling) et
 * renvoie les interactions (souris, clavier, molette, navigation) au serveur,
 * qui les rejoue sur la page Playwright.
 *
 * Toute la configuration vit dans le panneau « Paramètres » : rien de réglable
 * n'est dispersé ailleurs dans l'interface.
 */

const $ = (id) => document.getElementById(id);

const els = {
  back: $('btn-back'),
  forward: $('btn-forward'),
  reload: $('btn-reload'),
  home: $('btn-home'),
  go: $('btn-go'),
  form: $('address-form'),
  url: $('url-input'),

  viewer: $('viewer'),
  stage: $('stage'),
  canvas: $('screen'),
  focusHint: $('focus-hint'),
  ambient: $('ambient'),
  ambientCanvas: $('ambient-canvas'),

  statusDot: $('status-dot'),
  statusText: $('status-text'),
  metrics: $('metrics'),

  settingsBtn: $('btn-settings'),
  settings: $('settings'),
  closeSettings: $('btn-close-settings'),
  scrim: $('scrim'),

  segmented: $('mode-segmented'),
  thumb: $('mode-thumb'),
  modeNote: $('mode-note'),
  quality: $('quality'),
  qualityRow: $('quality-row'),
  qualityLabel: $('quality-label'),
  qualityValue: $('quality-value'),
  setAdaptive: $('set-adaptive'),
  setHidpi: $('set-hidpi'),
  hidpiRow: $('hidpi-row'),
  imageNote: $('image-note'),
  interval: $('interval'),
  intervalValue: $('interval-value'),
  intervalRow: $('interval-row'),
  autosize: $('autosize'),
  viewportRow: $('viewport-row'),
  viewportPreset: $('viewport-preset'),
  setAmbient: $('set-ambient'),
  setMetrics: $('set-metrics'),
  setSmooth: $('set-smooth'),

  searchEngine: $('search-engine'),
  replayOnboarding: $('btn-replay-onboarding'),

  onboarding: $('onboarding'),
  onbDots: $('onb-dots'),
  onbEngines: $('onb-engines'),
  onbProfiles: $('onb-profiles'),
  onbAmbient: $('onb-ambient'),
  onbMetrics: $('onb-metrics'),
  onbSkip: $('onb-skip'),
  onbBack: $('onb-back'),
  onbNext: $('onb-next'),

  factUser: $('fact-user'),
  factSession: $('fact-session'),
  factViewport: $('fact-viewport'),
  factRate: $('fact-rate'),
  factLatency: $('fact-latency'),
  newSession: $('btn-new'),
  logout: $('btn-logout'),

  loader: $('loader'),
  loaderText: $('loader-text'),
  toasts: $('toasts'),
};

const ctx2d = els.canvas.getContext('2d', { alpha: false, desynchronized: true });
const ambientCtx = els.ambientCanvas.getContext('2d', { alpha: false });

const STORAGE_KEY = 'cloudbrowser.sessionId';
const SETTINGS_KEY = 'cloudbrowser.settings';
const ONBOARDED_KEY = 'cloudbrowser.onboarded';
const MOVE_THROTTLE_MS = 45;

const DEFAULT_SETTINGS = {
  mode: 'screencast', // screencast | poll-ws | poll-http
  engine: 'duckduckgo',
  adaptive: true,
  quality: 60,
  hidpi: false,
  interval: 250,
  autosize: true,
  viewport: '1280x720',
  ambient: true,
  metrics: false,
  smooth: true,
};

const MODE_NOTES = {
  screencast: 'Le serveur pousse une image à chaque changement visuel. Le plus fluide et le plus économe.',
  'poll-ws': 'Captures à intervalle régulier, transmises sur le WebSocket. Plus robuste, plus coûteux.',
  'poll-http': 'Captures récupérées une par une en HTTP. Le WebSocket ne sert plus qu’aux interactions.',
};

const state = {
  sessionId: null,
  ws: null,
  connected: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  pollTimer: null,
  pollToken: null,
  frameSize: { width: 1280, height: 720 },
  serverViewport: { width: 1280, height: 720 },
  decoding: false,
  pendingFrame: null,
  buttonsDown: new Set(),
  lastMoveSentAt: 0,
  settings: { ...DEFAULT_SETTINGS },
  // « backlog » = frames écartées avant décodage : signe que le client ne suit plus.
  metrics: { frames: 0, bytes: 0, latency: null, backlog: 0, windowStart: performance.now() },
};

// --------------------------------------------------------------- utilitaires

function toast(message, level = 'info', ttl = 5000) {
  const node = document.createElement('div');
  node.className = `toast ${level}`;
  node.textContent = message;
  els.toasts.appendChild(node);
  setTimeout(() => node.remove(), ttl);
}

function setStatus(text, kind = 'pending') {
  els.statusText.textContent = text;
  els.statusDot.className = `dot ${kind}`;
}

function setLoading(visible, text = 'Chargement…') {
  els.loaderText.textContent = text;
  els.loader.hidden = !visible;
}

function setControlsEnabled(enabled) {
  for (const btn of [els.back, els.forward, els.reload, els.home, els.go]) btn.disabled = !enabled;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401) {
    location.replace('/login.html');
    throw new Error('Authentification requise.');
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Erreur HTTP ${response.status}`);
    error.code = payload.error;
    error.status = response.status;
    throw error;
  }
  return payload;
}

// ---------------------------------------------------------------- paramètres

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* navigation privée : les réglages ne survivront pas à la session */
  }
}

function openSettings() {
  els.settings.classList.add('open');
  els.scrim.classList.add('open');
  els.settingsBtn.setAttribute('aria-expanded', 'true');
  positionThumb();
  els.closeSettings.focus();
}

function closeSettings() {
  els.settings.classList.remove('open');
  els.scrim.classList.remove('open');
  els.settingsBtn.setAttribute('aria-expanded', 'false');
}

/** Place le « thumb » de verre sous l'option de flux active. */
function positionThumb() {
  const active = els.segmented.querySelector(`[data-mode="${state.settings.mode}"]`);
  if (!active) return;
  els.thumb.style.width = `${active.offsetWidth}px`;
  els.thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
}

function paintSlider(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill-pct', `${pct}%`);
}

/** Reporte l'état des réglages sur les contrôles et sur l'affichage. */
function renderSettings() {
  const s = state.settings;

  for (const segment of els.segmented.querySelectorAll('.segment')) {
    segment.setAttribute('aria-checked', String(segment.dataset.mode === s.mode));
  }
  positionThumb();
  els.modeNote.textContent = MODE_NOTES[s.mode];

  els.setAdaptive.checked = s.adaptive;
  els.setHidpi.checked = s.hidpi;
  // Le screencast CDP capture en pixels CSS : l'échelle ×2 n'a d'effet que sur
  // le chemin « capture », donc dans les modes polling.
  const hidpiAvailable = s.mode !== 'screencast';
  els.hidpiRow.classList.toggle('disabled', !hidpiAvailable);
  els.imageNote.textContent = s.adaptive
    ? 'Le serveur ajuste la qualité selon la latence mesurée : il descend vite quand le trajet sature, remonte doucement quand il respire.'
    : 'Qualité fixe. Plus elle est haute, plus chaque image est lourde à transmettre.';
  if (!hidpiAvailable) {
    els.imageNote.textContent +=
      ' La netteté ×2 n’est disponible qu’en mode polling — le screencast CDP capture en pixels CSS.';
  }
  els.qualityLabel.textContent = s.adaptive ? 'Qualité (automatique)' : 'Qualité JPEG';
  els.qualityRow.classList.toggle('disabled', s.adaptive);
  els.quality.value = s.quality;
  els.qualityValue.value = s.quality;
  paintSlider(els.quality);

  els.interval.value = s.interval;
  els.intervalValue.value = `${s.interval} ms`;
  paintSlider(els.interval);
  els.intervalRow.classList.toggle('disabled', s.mode === 'screencast');

  els.autosize.checked = s.autosize;
  els.viewportRow.classList.toggle('disabled', s.autosize);
  els.viewportPreset.value = s.viewport;
  if (els.searchEngine.options.length) els.searchEngine.value = s.engine;

  els.setAmbient.checked = s.ambient;
  els.setMetrics.checked = s.metrics;
  els.setSmooth.checked = s.smooth;

  els.ambient.classList.toggle('on', s.ambient);
  els.metrics.hidden = !s.metrics;
  els.canvas.classList.toggle('pixelated', !s.smooth);
}

let streamSettingsTimer = null;
function pushStreamSettings() {
  clearTimeout(streamSettingsTimer);
  streamSettingsTimer = setTimeout(() => {
    sendMessage({
      type: 'settings',
      jpegQuality: state.settings.quality,
      pollIntervalMs: state.settings.interval,
      adaptive: state.settings.adaptive,
      searchEngine: state.settings.engine,
    });
  }, 120);
}

function updateSetting(key, value, { restream = false, viewport = false } = {}) {
  state.settings[key] = value;
  saveSettings();
  renderSettings();
  if (restream) pushStreamSettings();
  if (viewport) applyViewport();
}

// ------------------------------------------------------------------ session

async function ensureSession() {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      await api(`/api/session/${stored}`);
      state.sessionId = stored;
      return stored;
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  setLoading(true, 'Ouverture d’une session distante…');
  const created = await api('/api/session', {
    method: 'POST',
    body: { deviceScaleFactor: state.settings.hidpi ? 2 : 1, searchEngine: state.settings.engine },
  });
  state.sessionId = created.sessionId;
  state.serverViewport = created.viewport;
  sessionStorage.setItem(STORAGE_KEY, created.sessionId);
  return created.sessionId;
}

async function startup() {
  setStatus('Connexion…', 'pending');

  const identity = await fetch('/api/auth/me').then((r) => r.json()).catch(() => null);
  if (identity && !identity.authEnabled) els.logout?.remove();
  els.factUser.textContent = identity?.user ?? '—';

  try {
    await ensureSession();
    els.factSession.textContent = state.sessionId.slice(0, 12) + '…';
    connect();
  } catch (err) {
    setLoading(false);
    const saturated = err.status === 503 || err.status === 429;
    setStatus(err.status === 429 ? 'Quota atteint' : saturated ? 'Serveur saturé' : 'Erreur', 'offline');
    toast(err.message, 'error', 12000);
    // Une place peut se libérer (session inactive purgée, autre onglet fermé).
    if (saturated) setTimeout(startup, 15000);
  }
}

function connect() {
  clearTimeout(state.reconnectTimer);
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws?sessionId=${encodeURIComponent(state.sessionId)}`);
  ws.binaryType = 'blob';
  state.ws = ws;
  setLoading(true, 'Connexion au navigateur distant…');

  ws.addEventListener('open', () => {
    state.connected = true;
    state.reconnectAttempt = 0;
    setStatus('Connecté', 'online');
    setControlsEnabled(true);
    applyMode(state.settings.mode, { silent: true });
    pushStreamSettings();
    applyViewport();
  });

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      queueFrame(event.data);
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  ws.addEventListener('close', (event) => {
    state.connected = false;
    setControlsEnabled(false);
    stopHttpPolling();
    if (event.code === 4004 || event.code === 4001) {
      sessionStorage.removeItem(STORAGE_KEY);
      setStatus('Session expirée', 'offline');
      toast('La session distante a expiré, ouverture d’une nouvelle session…', 'warn');
      setTimeout(startup, 800);
      return;
    }
    if (event.code === 4003) {
      sessionStorage.removeItem(STORAGE_KEY);
      setStatus('Accès refusé', 'offline');
      toast('Cette session appartient à un autre utilisateur.', 'error', 12000);
      return;
    }
    if (event.code === 4009) {
      setStatus('Session reprise ailleurs', 'offline');
      toast('Cette session a été reprise dans un autre onglet.', 'warn', 15000);
      return;
    }
    scheduleReconnect();
  });

  ws.addEventListener('error', () => setStatus('Erreur réseau', 'offline'));
}

async function scheduleReconnect() {
  // Une déconnexion peut simplement signifier que le cookie a expiré.
  const identity = await fetch('/api/auth/me').then((r) => r.json()).catch(() => null);
  if (identity && identity.authEnabled && !identity.authenticated) {
    location.replace('/login.html');
    return;
  }
  state.reconnectAttempt += 1;
  const delay = Math.min(10000, 500 * 2 ** (state.reconnectAttempt - 1));
  setStatus(`Reconnexion dans ${Math.round(delay / 1000)} s…`, 'pending');
  setLoading(true, 'Reconnexion…');
  state.reconnectTimer = setTimeout(connect, delay);
}

function handleServerMessage(message) {
  switch (message.type) {
    case 'ready':
      updateStateUi(message.state);
      setLoading(false);
      break;
    case 'state':
      updateStateUi(message);
      break;
    case 'notice':
      toast(message.message, message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'info');
      break;
    case 'error':
      setLoading(false);
      toast(message.message, 'error', 9000);
      break;
    case 'closed':
      toast(`Session fermée : ${message.reason}`, 'warn');
      break;
    case 'pong':
      state.metrics.latency = Math.round(performance.now() - message.t);
      break;
    case 'quality':
      // Le régulateur a ajusté la qualité : on reflète sa décision sans la renvoyer.
      state.settings.quality = message.value;
      els.quality.value = message.value;
      els.qualityValue.value = message.value;
      paintSlider(els.quality);
      break;
    default:
      break;
  }
}

function updateStateUi(pageState = {}) {
  // La page d'accueil distante a son propre sélecteur : on reste synchronisé.
  const engine = pageState.preferences?.searchEngine;
  if (engine && engine !== state.settings.engine) {
    state.settings.engine = engine;
    saveSettings();
    renderSettings();
  }
  if (pageState.viewport) {
    state.serverViewport = pageState.viewport;
    els.factViewport.textContent = `${pageState.viewport.width} × ${pageState.viewport.height}`;
  }
  if (pageState.url && document.activeElement !== els.url) {
    els.url.value = pageState.url === 'about:blank' ? '' : pageState.url;
  }
  document.title = pageState.title ? `${pageState.title} — Cloud Browser` : 'Cloud Browser';
  if (pageState.loading) setLoading(true, 'Chargement de la page…');
  else setLoading(false);
}

function sendMessage(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

// ------------------------------------------------------------------- rendu

function queueFrame(blob) {
  state.metrics.bytes += blob.size ?? 0;
  if (state.pendingFrame) state.metrics.backlog += 1; // une frame chasse l'autre : on est en retard
  state.pendingFrame = blob; // seule la frame la plus récente est décodée
  if (!state.decoding) void drawPending();
}

async function drawPending() {
  state.decoding = true;
  try {
    while (state.pendingFrame) {
      const blob = state.pendingFrame;
      state.pendingFrame = null;
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width !== els.canvas.width || bitmap.height !== els.canvas.height) {
        els.canvas.width = bitmap.width;
        els.canvas.height = bitmap.height;
        state.frameSize = { width: bitmap.width, height: bitmap.height };
        layoutCanvas();
      }
      ctx2d.drawImage(bitmap, 0, 0);
      // Halo ambiant : une vignette minuscule, floutée par CSS.
      if (state.settings.ambient) {
        ambientCtx.drawImage(bitmap, 0, 0, els.ambientCanvas.width, els.ambientCanvas.height);
      }
      bitmap.close();
      state.metrics.frames += 1;
    }
  } catch {
    /* frame corrompue : on ignore */
  } finally {
    state.decoding = false;
  }
}

/** Ajuste la taille CSS du canvas pour conserver le ratio sans letterboxing interne. */
function layoutCanvas() {
  const rect = els.stage.getBoundingClientRect();
  const { width, height } = state.frameSize;
  const scale = Math.min(rect.width / width, rect.height / height, 1);
  els.canvas.style.width = `${Math.floor(width * scale)}px`;
  els.canvas.style.height = `${Math.floor(height * scale)}px`;
}

// ------------------------------------------------------- modes de streaming

function applyMode(value, { silent = false } = {}) {
  state.settings.mode = value;
  saveSettings();
  renderSettings();
  stopHttpPolling();

  if (value === 'poll-http') {
    sendMessage({ type: 'stream', enabled: false });
    startHttpPolling();
  } else {
    sendMessage({ type: 'stream', enabled: true });
    sendMessage({ type: 'mode', mode: value === 'poll-ws' ? 'poll' : 'screencast' });
  }
  if (!silent) toast(`Flux : ${MODE_NOTES[value].split('.')[0]}.`);
}

/**
 * Boucle auto-cadencée : la capture suivante est planifiée à la fin de la
 * précédente, ce qui évite l'empilement des requêtes sur une page lente.
 */
function startHttpPolling() {
  const token = Symbol('poll');
  state.pollToken = token;

  const loop = async () => {
    if (state.pollToken !== token) return;
    const startedAt = performance.now();
    if (!document.hidden && state.sessionId) {
      try {
        const response = await fetch(`/api/session/${state.sessionId}/screenshot?t=${Date.now()}`, { cache: 'no-store' });
        if (response.ok) queueFrame(await response.blob());
      } catch {
        /* on réessaiera au tour suivant */
      }
    }
    if (state.pollToken !== token) return;
    const remaining = Math.max(0, state.settings.interval - (performance.now() - startedAt));
    state.pollTimer = setTimeout(loop, remaining);
  };

  loop();
}

function stopHttpPolling() {
  state.pollToken = null;
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

// ------------------------------------------------------------------ inputs

function viewerHasFocus() {
  return document.activeElement === els.viewer || els.viewer.contains(document.activeElement);
}

function toNormalized(event) {
  const rect = els.canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function isInsideCanvas(event) {
  const rect = els.canvas.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

els.canvas.addEventListener('mousedown', (event) => {
  event.preventDefault();
  els.viewer.focus();
  state.buttonsDown.add(event.button);
  const { x, y } = toNormalized(event);
  sendMessage({ type: 'mouse', action: 'down', x, y, button: event.button, clickCount: Math.min(3, event.detail || 1) });
});

window.addEventListener('mouseup', (event) => {
  if (!state.buttonsDown.has(event.button)) return;
  state.buttonsDown.delete(event.button);
  const { x, y } = toNormalized(event);
  sendMessage({ type: 'mouse', action: 'up', x, y, button: event.button, clickCount: Math.min(3, event.detail || 1) });
});

window.addEventListener('mousemove', (event) => {
  if (!state.connected) return;
  if (!state.buttonsDown.size && !isInsideCanvas(event)) return;
  const now = performance.now();
  if (now - state.lastMoveSentAt < MOVE_THROTTLE_MS) return;
  state.lastMoveSentAt = now;
  const { x, y } = toNormalized(event);
  sendMessage({ type: 'mouse', action: 'move', x, y });
});

els.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

els.canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const { x, y } = toNormalized(event);
    // deltaMode 1 = lignes, 2 = pages : on convertit en pixels.
    const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? state.serverViewport.height : 1;
    sendMessage({ type: 'wheel', x, y, deltaX: event.deltaX * factor, deltaY: event.deltaY * factor });
  },
  { passive: false },
);

// Touches que l'on laisse au navigateur local (outils de développement).
const PASSTHROUGH_KEYS = new Set(['F12']);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && els.settings.classList.contains('open')) {
    closeSettings();
    return;
  }
  if (!viewerHasFocus()) return;
  if (PASSTHROUGH_KEYS.has(event.key) || (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'i')) return;
  // Raccourcis locaux de navigation.
  if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    sendMessage({ type: 'back' });
    return;
  }
  if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    sendMessage({ type: 'forward' });
    return;
  }
  if (event.key === 'F5' || (event.key.toLowerCase() === 'r' && (event.ctrlKey || event.metaKey))) {
    event.preventDefault();
    sendMessage({ type: 'reload' });
    return;
  }
  if (event.key.toLowerCase() === 'l' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    els.url.focus();
    els.url.select();
    return;
  }
  event.preventDefault();
  sendMessage({ type: 'key', action: 'down', key: event.key });
});

window.addEventListener('keyup', (event) => {
  if (!viewerHasFocus()) return;
  if (PASSTHROUGH_KEYS.has(event.key)) return;
  event.preventDefault();
  sendMessage({ type: 'key', action: 'up', key: event.key });
});

window.addEventListener('paste', (event) => {
  if (!viewerHasFocus()) return;
  const text = event.clipboardData?.getData('text');
  if (!text) return;
  event.preventDefault();
  sendMessage({ type: 'text', text });
});

els.viewer.addEventListener('focus', () => els.focusHint.classList.add('hidden'));
els.viewer.addEventListener('blur', () => {
  els.focusHint.classList.remove('hidden');
  // Relâche les modificateurs restés enfoncés côté distant.
  for (const key of ['Control', 'Shift', 'Alt', 'Meta']) sendMessage({ type: 'key', action: 'up', key });
});

// --------------------------------------------------------- barre d'adresse

function submitAddress() {
  const value = els.url.value.trim();
  if (!value || !state.connected) return;
  setLoading(true, 'Chargement de la page…');
  sendMessage({ type: 'navigate', url: value });
  els.viewer.focus();
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAddress();
});

// Filet de sécurité : certains contextes n'émettent pas la soumission implicite.
els.url.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  submitAddress();
});

els.back.addEventListener('click', () => sendMessage({ type: 'back' }));
els.forward.addEventListener('click', () => sendMessage({ type: 'forward' }));
els.reload.addEventListener('click', () => sendMessage({ type: 'reload' }));
els.home.addEventListener('click', () => {
  sendMessage({ type: 'home' });
  els.url.value = '';
});

// ------------------------------------------------- panneau des paramètres

els.settingsBtn.addEventListener('click', () => {
  if (els.settings.classList.contains('open')) closeSettings();
  else openSettings();
});
els.closeSettings.addEventListener('click', closeSettings);
els.scrim.addEventListener('click', closeSettings);

els.segmented.addEventListener('click', (event) => {
  const segment = event.target.closest('.segment');
  if (segment) applyMode(segment.dataset.mode);
});

els.setAdaptive.addEventListener('change', () => updateSetting('adaptive', els.setAdaptive.checked, { restream: true }));
els.setHidpi.addEventListener('change', () => {
  updateSetting('hidpi', els.setHidpi.checked);
  toast(
    `Netteté ${els.setHidpi.checked ? '×2' : '×1'} : la résolution de rendu se fixe à l’ouverture du contexte. ` +
      'Ouvrez une nouvelle session pour l’appliquer.',
    'warn',
    9000,
  );
});
els.quality.addEventListener('input', () => updateSetting('quality', Number(els.quality.value), { restream: true }));
els.interval.addEventListener('input', () => updateSetting('interval', Number(els.interval.value), { restream: true }));

els.autosize.addEventListener('change', () => updateSetting('autosize', els.autosize.checked, { viewport: true }));
els.viewportPreset.addEventListener('change', () => updateSetting('viewport', els.viewportPreset.value, { viewport: true }));
els.searchEngine.addEventListener('change', () => updateSetting('engine', els.searchEngine.value, { restream: true }));

els.setAmbient.addEventListener('change', () => updateSetting('ambient', els.setAmbient.checked));
els.setMetrics.addEventListener('change', () => updateSetting('metrics', els.setMetrics.checked));
els.setSmooth.addEventListener('change', () => updateSetting('smooth', els.setSmooth.checked));

els.newSession.addEventListener('click', async () => {
  const id = state.sessionId;
  closeSettings();
  stopHttpPolling();
  state.ws?.close(1000, 'nouvelle session');
  sessionStorage.removeItem(STORAGE_KEY);
  state.sessionId = null;
  if (id) await api(`/api/session/${id}`, { method: 'DELETE' }).catch(() => {});
  startup();
});

els.logout?.addEventListener('click', async () => {
  const id = state.sessionId;
  stopHttpPolling();
  state.ws?.close(1000, 'déconnexion');
  sessionStorage.removeItem(STORAGE_KEY);
  if (id) await api(`/api/session/${id}`, { method: 'DELETE' }).catch(() => {});
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login.html');
});

// ------------------------------------------------------- taille & métriques

let resizeTimer = null;

function applyViewport() {
  layoutCanvas();
  if (!state.connected) return;
  if (state.settings.autosize) {
    const rect = els.stage.getBoundingClientRect();
    sendMessage({ type: 'viewport', width: Math.floor(rect.width), height: Math.floor(rect.height) });
  } else {
    const [width, height] = state.settings.viewport.split('x').map(Number);
    sendMessage({ type: 'viewport', width, height });
  }
}

new ResizeObserver(() => {
  layoutCanvas();
  positionThumb();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyViewport, 350);
}).observe(els.stage);

setInterval(() => {
  const now = performance.now();
  const elapsed = (now - state.metrics.windowStart) / 1000;
  const fps = state.metrics.frames / elapsed;
  const kbs = state.metrics.bytes / 1024 / elapsed;
  const latency = state.metrics.latency === null ? '—' : state.metrics.latency;
  els.metrics.textContent = `${fps.toFixed(1)} fps · ${kbs.toFixed(0)} ko/s · ${latency} ms`;
  els.factRate.textContent = `${fps.toFixed(1)} fps · ${kbs.toFixed(0)} ko/s`;
  els.factLatency.textContent = state.metrics.latency === null ? '—' : `${state.metrics.latency} ms`;

  // Ce que le serveur ne peut pas voir : le trajet réel et notre retard de décodage.
  sendMessage({ type: 'telemetry', rtt: state.metrics.latency, backlog: state.metrics.backlog });
  state.metrics = { frames: 0, bytes: 0, latency: state.metrics.latency, backlog: 0, windowStart: now };
}, 1000);

// Sonde de latence fréquente : c'est le signal qui pilote la qualité.
setInterval(() => sendMessage({ type: 'ping', t: performance.now() }), 1000);

document.addEventListener('visibilitychange', () => {
  // Reprend l'affichage après un retour d'onglet (le screencast n'émet que sur changement).
  if (!document.hidden && state.connected && state.settings.mode !== 'poll-http') sendMessage({ type: 'refresh' });
});


// ------------------------------------------------------------ introduction

const PROFILES = {
  auto: { adaptive: true },
  fluid: { adaptive: false, quality: 45, mode: 'screencast' },
  sharp: { adaptive: false, quality: 88 },
};

let engines = [];
let onbStep = 0;
let onbChoice = { engine: null, profile: 'auto' };

async function loadEngines() {
  engines = await fetch('/api/engines')
    .then((r) => r.json())
    .then((d) => d.engines ?? [])
    .catch(() => []);
  if (!engines.length) return;

  els.searchEngine.replaceChildren(
    ...engines.map((e) => {
      const option = document.createElement('option');
      option.value = e.id;
      option.textContent = e.label;
      return option;
    }),
  );

  els.onbEngines.replaceChildren(
    ...engines.map((e) => {
      const button = document.createElement('button');
      button.className = 'onb-engine';
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.dataset.engine = e.id;
      button.innerHTML = `<span class="onb-badge" style="background:${e.color}">${e.glyph}</span>${e.label}`;
      button.addEventListener('click', () => {
        onbChoice.engine = e.id;
        for (const other of els.onbEngines.children) {
          other.setAttribute('aria-checked', String(other === button));
        }
      });
      return button;
    }),
  );
  renderSettings();
}

function showOnboarding() {
  onbStep = 0;
  onbChoice = { engine: state.settings.engine, profile: state.settings.adaptive ? 'auto' : 'sharp' };
  for (const button of els.onbEngines.children) {
    button.setAttribute('aria-checked', String(button.dataset.engine === onbChoice.engine));
  }
  for (const button of els.onbProfiles.children) {
    button.setAttribute('aria-checked', String(button.dataset.profile === onbChoice.profile));
  }
  els.onbAmbient.checked = state.settings.ambient;
  els.onbMetrics.checked = state.settings.metrics;
  els.onboarding.hidden = false;
  renderOnboarding();
}

function renderOnboarding() {
  for (const section of els.onboarding.querySelectorAll('.onb-step')) {
    section.hidden = Number(section.dataset.step) !== onbStep;
  }
  [...els.onbDots.children].forEach((dot, index) => dot.classList.toggle('on', index === onbStep));
  els.onbBack.hidden = onbStep === 0;
  els.onbNext.textContent = onbStep === 2 ? 'Commencer' : 'Suivant';
  els.onbSkip.hidden = onbStep === 2;
}

function finishOnboarding({ apply = true } = {}) {
  if (apply) {
    const profile = PROFILES[onbChoice.profile] ?? PROFILES.auto;
    Object.assign(state.settings, profile, {
      engine: onbChoice.engine ?? state.settings.engine,
      ambient: els.onbAmbient.checked,
      metrics: els.onbMetrics.checked,
    });
    saveSettings();
    renderSettings();
    if (state.connected) {
      applyMode(state.settings.mode, { silent: true });
      pushStreamSettings();
    }
  }
  try {
    localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    /* stockage indisponible : l'introduction réapparaîtra */
  }
  els.onboarding.hidden = true;
}

els.onbProfiles.addEventListener('click', (event) => {
  const choice = event.target.closest('.onb-choice');
  if (!choice) return;
  onbChoice.profile = choice.dataset.profile;
  for (const other of els.onbProfiles.children) other.setAttribute('aria-checked', String(other === choice));
});

els.onbNext.addEventListener('click', () => {
  if (onbStep === 2) return finishOnboarding();
  onbStep += 1;
  renderOnboarding();
});
els.onbBack.addEventListener('click', () => {
  onbStep = Math.max(0, onbStep - 1);
  renderOnboarding();
});
els.onbSkip.addEventListener('click', () => finishOnboarding({ apply: false }));

els.replayOnboarding.addEventListener('click', () => {
  closeSettings();
  showOnboarding();
});

function isOnboarded() {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return true;
  }
}

state.settings = loadSettings();
renderSettings();
loadEngines().then(() => {
  // L'introduction ne s'affiche qu'au premier lancement ; la session se prépare
  // pendant ce temps, elle n'attend pas.
  if (!isOnboarded()) showOnboarding();
});
startup();
