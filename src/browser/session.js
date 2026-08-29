import { EventEmitter } from 'node:events';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { withTimeout, safeTimeout } from '../util/withTimeout.js';
import { validateUrl } from '../util/url.js';
import renderHomePage, { ENGINE_BINDING, HOME_BINDING } from './homePage.js';
import { getEngine } from './searchEngines.js';
import ScreencastStreamer from '../streaming/screencast.js';
import PollingStreamer from '../streaming/poller.js';

const log = createLogger('session');

const MOUSE_BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };

// Correspondances DOM KeyboardEvent.key -> noms de touches Playwright.
const KEY_ALIASES = {
  ' ': 'Space',
  Spacebar: 'Space',
  Esc: 'Escape',
  Del: 'Delete',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  OS: 'Meta',
};
const IGNORED_KEYS = new Set(['Dead', 'Unidentified', 'Process', 'Compose']);

const clampClickCount = (value) => Math.min(3, Math.max(1, Number(value) || 1));

/**
 * Une session utilisateur = un BrowserContext isolé (cookies/localStorage propres)
 * + une page active + un streamer. Le process Chromium, lui, est partagé.
 */
export class Session extends EventEmitter {
  #context;
  #release;
  #page = null;
  #streamer = null;
  #mode;
  #streamLock = Promise.resolve();
  #stateTimer = null;
  #closed = false;
  #canSend = () => true;
  #onHome = false;
  // Vrai pendant nos propres appels à newPage() : évite de traiter la page que
  // l'on vient de créer comme un pop-up ouvert par le site.
  #creatingOwnPage = false;

  constructor({ id, context, release, instanceId, owner, deviceScaleFactor, searchEngine }) {
    super();
    this.id = id;
    this.#context = context;
    this.#release = release;
    this.instanceId = instanceId;
    // Identité propriétaire : un sessionId volé ne suffit pas à reprendre la session.
    this.owner = owner;
    this.createdAt = Date.now();
    this.lastUsed = Date.now();
    this.viewport = { ...config.session.viewport };
    this.#mode = config.stream.defaultMode;
    // Réglages de flux propres à la session, modifiables depuis l'interface.
    this.streamOptions = {
      jpegQuality: config.stream.jpegQuality,
      pollIntervalMs: config.stream.pollIntervalMs,
      adaptive: config.stream.adaptive,
      // Fixé à la création du contexte : Playwright réapplique ses propres
      // métriques de rendu, un override CDP posé après coup ne tient pas.
      deviceScaleFactor: deviceScaleFactor ?? config.session.deviceScaleFactor,
    };
    // Préférences de navigation, partagées entre l'accueil et la barre d'adresse.
    this.preferences = { searchEngine: getEngine(searchEngine ?? config.session.searchEngine).id };
    // Mémoire du régulateur de débit (voir applyTelemetry).
    this.telemetry = { rtt: null, baselineRtt: null, excessMs: 0, lastChangeAt: 0 };
    this.navigations = 0;
    this.lastError = null;
  }

  get mode() {
    return this.#mode;
  }

  get closed() {
    return this.#closed;
  }

  get page() {
    return this.#page;
  }

  touch() {
    this.lastUsed = Date.now();
  }

  /** Contrôle de flux : le transport (WebSocket) décide s'il peut absorber une frame. */
  setCanSend(fn) {
    this.#canSend = typeof fn === 'function' ? fn : () => true;
  }

  async init() {
    this.#context.setDefaultTimeout(config.timeouts.action);
    this.#context.setDefaultNavigationTimeout(config.timeouts.goto);

    // Les pop-ups / liens target=_blank deviennent la page active.
    this.#context.on('page', (page) => {
      if (this.#creatingOwnPage) return;
      this.#adoptPage(page);
    });
    // Si le contexte disparaît (crash Chromium, fermeture forcée d'une instance
    // en fin de drainage), la session doit se terminer proprement côté client.
    this.#context.on('close', () => {
      if (!this.#closed) this.close('navigateur distant arrêté').catch(() => {});
    });
    // Aucun téléchargement : on ne veut pas remplir le disque du VPS.
    this.#context.on('download', (download) => {
      download.cancel().catch(() => {});
      this.emit('notice', { level: 'warn', message: `Téléchargement bloqué : ${download.suggestedFilename()}` });
    });

    // Passerelle utilisée par la page d'accueil : la saisie repasse par la même
    // validation d'URL que la barre d'adresse.
    await safeTimeout(
      this.#context.exposeBinding(HOME_BINDING, (_source, url) => {
        this.navigate(url).catch((err) => this.emit('notice', { level: 'error', message: err.message }));
      }),
      config.timeouts.action,
      'context.exposeBinding',
    );
    await safeTimeout(
      this.#context.exposeBinding(ENGINE_BINDING, (_source, id) => {
        this.setPreferences({ searchEngine: id }, { rerenderHome: false }).catch(() => {});
      }),
      config.timeouts.action,
      'context.exposeBinding(engine)',
    );

    await this.#activatePage(await this.#createOwnPage());

    this.showHome().catch(() => {});
    log.info(`Session ${this.id} initialisée (Chromium #${this.instanceId}, mode=${this.#mode}).`);
    return this;
  }

  // ---------------------------------------------------------------- pages ---

  async #createOwnPage() {
    this.#creatingOwnPage = true;
    try {
      return await withTimeout(this.#context.newPage(), config.timeouts.action, 'context.newPage');
    } finally {
      this.#creatingOwnPage = false;
    }
  }

  #wirePage(page) {
    page.setDefaultTimeout(config.timeouts.action);
    page.setDefaultNavigationTimeout(config.timeouts.goto);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (page.url() !== 'about:blank') this.#onHome = false;
      this.#scheduleState();
    });
    page.on('load', () => this.#scheduleState());
    page.on('domcontentloaded', () => this.#scheduleState());
    page.on('dialog', (dialog) => {
      // Les dialogues natifs bloquent la page tant qu'ils ne sont pas traités.
      dialog.dismiss().catch(() => {});
      this.emit('notice', { level: 'info', message: `Dialogue « ${dialog.type()} » fermé automatiquement : ${dialog.message()}` });
    });
    page.on('crash', () => {
      this.emit('notice', { level: 'error', message: 'La page a crashé, rechargement conseillé.' });
    });
    page.on('close', () => this.#handlePageClose(page));
  }

  async #activatePage(page) {
    this.#wirePage(page);
    this.#page = page;
    await safeTimeout(page.setViewportSize(this.viewport), config.timeouts.action, 'setViewportSize');
    await safeTimeout(page.bringToFront(), config.timeouts.action, 'bringToFront');
    await this.#restartStreamer();
    this.#scheduleState();
  }

  async #adoptPage(page) {
    if (this.#closed || page === this.#page) return;
    try {
      await safeTimeout(page.waitForLoadState('domcontentloaded'), config.timeouts.goto, 'popup.waitForLoadState');
      if (this.#closed || page.isClosed()) return;
      log.debug(`Session ${this.id}: nouvelle page adoptée (${page.url()}).`);
      await this.#stopStreamer();
      await this.#activatePage(page);
      this.emit('notice', { level: 'info', message: 'Nouvel onglet ouvert par le site : affichage basculé dessus.' });
    } catch (err) {
      log.warn(`Session ${this.id}: adoption de page échouée:`, err.message);
    }
  }

  async #handlePageClose(page) {
    if (this.#closed || page !== this.#page) return;
    const remaining = this.#context.pages().filter((p) => !p.isClosed());
    try {
      await this.#stopStreamer();
      const fresh = remaining.length === 0;
      const next = remaining[remaining.length - 1] ?? (await this.#createOwnPage());
      await this.#activatePage(next);
      if (fresh) await this.showHome();
    } catch (err) {
      log.warn(`Session ${this.id}: impossible de rebasculer après fermeture de page:`, err.message);
    }
  }

  // ------------------------------------------------------------ streaming ---

  /** Réglages de flux applicables à chaud (l'échelle de rendu, elle, ne l'est pas). */
  async setStreamOptions({ jpegQuality, pollIntervalMs, adaptive } = {}) {
    const clamp = (value, min, max, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    };
    const previous = this.streamOptions;
    this.streamOptions = {
      jpegQuality: clamp(jpegQuality, 10, 100, previous.jpegQuality),
      pollIntervalMs: clamp(pollIntervalMs, 100, 2000, previous.pollIntervalMs),
      adaptive: typeof adaptive === 'boolean' ? adaptive : previous.adaptive,
      deviceScaleFactor: previous.deviceScaleFactor,
    };
    this.touch();

    if (this.streamOptions.jpegQuality !== previous.jpegQuality) {
      await this.#applyQuality(this.streamOptions.jpegQuality);
    }
    if (this.streamOptions.pollIntervalMs !== previous.pollIntervalMs) {
      this.#streamer?.setInterval?.(this.streamOptions.pollIntervalMs);
    }
    // Repartir d'une mesure propre après un changement volontaire.
    if (this.streamOptions.adaptive !== previous.adaptive) this.telemetry.baselineRtt = null;
    this.#scheduleState();
    return this.streamOptions;
  }

  async #applyQuality(quality) {
    if (this.#streamer?.setQuality) await this.#streamer.setQuality(quality);
    else await this.#restartStreamer();
  }

  /**
   * Régulateur de débit. Le signal utile n'est pas le débit brut mais le
   * *gonflement* du temps d'aller-retour : quand les images saturent le trajet,
   * elles font la queue devant les clics, et c'est la latence perçue qui monte.
   * On descend vite (multiplicatif), on remonte lentement (additif).
   */
  applyTelemetry({ rtt, backlog = 0, bufferedBytes = 0 } = {}) {
    if (!this.streamOptions.adaptive || this.#closed) return null;

    if (Number.isFinite(rtt) && rtt >= 0) {
      this.telemetry.rtt = rtt;
      this.telemetry.baselineRtt =
        this.telemetry.baselineRtt === null ? rtt : Math.min(this.telemetry.baselineRtt, rtt);
      this.telemetry.excessMs = rtt - this.telemetry.baselineRtt;
    }

    const now = Date.now();
    const target = config.stream.targetLatencyMs;
    const congested = this.telemetry.excessMs > target || bufferedBytes > 256 * 1024 || backlog > 2;
    const roomy = this.telemetry.excessMs < target / 3 && bufferedBytes < 64 * 1024 && backlog === 0;

    let quality = this.streamOptions.jpegQuality;
    if (congested && now - this.telemetry.lastChangeAt > 700) {
      quality = Math.max(config.stream.minQuality, quality - 12);
    } else if (roomy && now - this.telemetry.lastChangeAt > 2500) {
      quality = Math.min(config.stream.maxQuality, quality + 4);
    }
    if (quality === this.streamOptions.jpegQuality) return null;

    this.telemetry.lastChangeAt = now;
    this.streamOptions.jpegQuality = quality;
    this.#applyQuality(quality).catch(() => {});
    return quality;
  }

  /** Préférences de navigation (moteur de recherche). */
  async setPreferences({ searchEngine } = {}, { rerenderHome = true } = {}) {
    const previous = this.preferences.searchEngine;
    if (searchEngine !== undefined) this.preferences.searchEngine = getEngine(searchEngine).id;
    this.touch();
    // L'accueil affiche le moteur courant : on le réinjecte s'il est visible —
    // sauf quand le changement vient de la page elle-même, qui s'est déjà mise
    // à jour et dont on ne veut pas effacer la saisie en cours.
    if (rerenderHome && this.preferences.searchEngine !== previous && this.#onHome) await this.showHome();
    else this.#scheduleState();
    return this.preferences;
  }

  /** Bascule entre les deux approches de streaming, à chaud. */

  /** Préférences de navigation (moteur de recherche). */
  async setPreferences({ searchEngine } = {}, { rerenderHome = true } = {}) {
    const previous = this.preferences.searchEngine;
    if (searchEngine !== undefined) this.preferences.searchEngine = getEngine(searchEngine).id;
    this.touch();
    // L'accueil affiche le moteur courant : on le réinjecte s'il est visible —
    // sauf quand le changement vient de la page elle-même, qui s'est déjà mise
    // à jour et dont on ne veut pas effacer la saisie en cours.
    if (rerenderHome && this.preferences.searchEngine !== previous && this.#onHome) await this.showHome();
    else this.#scheduleState();
    return this.preferences;
  }

  /** Bascule entre les deux approches de streaming, à chaud. */
  async setMode(mode) {
    const next = mode === 'poll' ? 'poll' : 'screencast';
    if (next === this.#mode && this.#streamer) return this.#mode;
    this.#mode = next;
    await this.#restartStreamer();
    this.#scheduleState();
    return this.#mode;
  }

  #buildStreamer() {
    const options = {
      context: this.#context,
      page: this.#page,
      canSend: () => this.#canSend(),
      quality: this.streamOptions.jpegQuality,
      intervalMs: this.streamOptions.pollIntervalMs,
      scale: this.streamOptions.deviceScaleFactor,
      onFrame: (buffer, metadata) => {
        if (!this.#closed) this.emit('frame', buffer, metadata);
      },
    };
    return this.#mode === 'poll' ? new PollingStreamer(options) : new ScreencastStreamer(options);
  }

  /** Les start/stop sont sérialisés : jamais deux streamers concurrents. */
  #restartStreamer() {
    this.#streamLock = this.#streamLock.then(async () => {
      if (this.#closed || !this.#page || this.#page.isClosed()) return;
      if (this.#streamer) {
        await this.#streamer.stop().catch(() => {});
        this.#streamer = null;
      }
      const streamer = this.#buildStreamer();
      try {
        await streamer.start();
        this.#streamer = streamer;
      } catch (err) {
        log.error(`Session ${this.id}: démarrage du streamer (${this.#mode}) impossible:`, err.message);
        if (this.#mode === 'screencast') {
          // Repli automatique sur le polling si le CDP est indisponible.
          this.#mode = 'poll';
          const fallback = this.#buildStreamer();
          await fallback.start().catch(() => {});
          this.#streamer = fallback;
          this.emit('notice', { level: 'warn', message: 'Screencast CDP indisponible : repli sur le mode polling.' });
        }
      }
    });
    return this.#streamLock;
  }

  #stopStreamer() {
    this.#streamLock = this.#streamLock.then(async () => {
      if (this.#streamer) {
        await this.#streamer.stop().catch(() => {});
        this.#streamer = null;
      }
    });
    return this.#streamLock;
  }

  /** Capture unitaire (endpoint REST « à la demande » / amorçage de l'affichage). */
  async screenshot() {
    this.touch();
    this.#assertOpen();
    return withTimeout(
      this.#page.screenshot({
        type: 'jpeg',
        quality: this.streamOptions.jpegQuality,
        timeout: config.timeouts.screenshot,
      }),
      config.timeouts.screenshot + 1_000,
      'page.screenshot',
    );
  }

  // ----------------------------------------------------------- navigation ---

  /**
   * Page d'accueil : une URL externe si HOME_URL est défini, sinon la page
   * intégrée, injectée sans requête réseau (l'adresse reste donc vide).
   */
  async showHome() {
    this.#assertOpen();
    this.touch();
    if (/^https?:\/\//i.test(config.session.homeUrl)) return this.navigate(config.session.homeUrl);

    // setContent ne change pas l'URL du document : sans ce passage par
    // about:blank, la barre d'adresse continuerait d'afficher le site précédent.
    if (this.#page.url() !== 'about:blank') {
      await safeTimeout(this.#page.goto('about:blank'), config.timeouts.goto, 'goto(about:blank)');
    }
    await withTimeout(
      this.#page.setContent(renderHomePage({ engineId: this.preferences.searchEngine }), {
        waitUntil: 'domcontentloaded',
      }),
      config.timeouts.goto,
      'page.setContent(home)',
    );
    this.#onHome = true;
    this.#scheduleState();
    return this.state();
  }

  async navigate(rawUrl) {
    this.#assertOpen();
    const url = await validateUrl(rawUrl, { searchTemplate: getEngine(this.preferences.searchEngine).search });
    this.#onHome = false;
    this.touch();
    this.navigations += 1;
    this.emit('state', { ...(await this.state()), loading: true, url });
    try {
      await withTimeout(
        this.#page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeouts.goto }),
        config.timeouts.goto + 2_000,
        `page.goto(${url})`,
      );
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      // Le site peut avoir partiellement chargé (timeout) : on remonte l'info
      // sans détruire la session.
      throw new NavigationError(describeNavigationError(err, url));
    } finally {
      this.#scheduleState();
    }
    return this.state();
  }

  async goBack() {
    this.touch();
    this.#assertOpen();
    await safeTimeout(this.#page.goBack({ waitUntil: 'domcontentloaded' }), config.timeouts.goto, 'page.goBack');
    this.#scheduleState();
  }

  async goForward() {
    this.touch();
    this.#assertOpen();
    await safeTimeout(this.#page.goForward({ waitUntil: 'domcontentloaded' }), config.timeouts.goto, 'page.goForward');
    this.#scheduleState();
  }

  async reload() {
    this.touch();
    this.#assertOpen();
    // Recharger la page d'accueil rechargerait un document vide : on la réinjecte.
    if (this.#page.url() === 'about:blank') return void (await this.showHome());
    await safeTimeout(this.#page.reload({ waitUntil: 'domcontentloaded' }), config.timeouts.goto, 'page.reload');
    this.#scheduleState();
  }

  async stopLoading() {
    this.touch();
    this.#assertOpen();
    await safeTimeout(
      this.#page.evaluate(() => window.stop()),
      config.timeouts.action,
      'window.stop',
    );
  }

  // --------------------------------------------------------------- inputs ---

  #toPageCoords(nx, ny) {
    const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    return {
      x: Math.round(clamp(nx) * this.viewport.width),
      y: Math.round(clamp(ny) * this.viewport.height),
    };
  }

  async mouseMove(nx, ny) {
    this.touch();
    this.#assertOpen();
    const { x, y } = this.#toPageCoords(nx, ny);
    await safeTimeout(this.#page.mouse.move(x, y), config.timeouts.action, 'mouse.move');
  }

  async mouseDown(nx, ny, button = 0, clickCount = 1) {
    this.touch();
    this.#assertOpen();
    const { x, y } = this.#toPageCoords(nx, ny);
    const options = { button: MOUSE_BUTTONS[button] ?? 'left', clickCount: clampClickCount(clickCount) };
    await safeTimeout(this.#page.mouse.move(x, y), config.timeouts.action, 'mouse.move');
    await safeTimeout(this.#page.mouse.down(options), config.timeouts.action, 'mouse.down');
  }

  async mouseUp(nx, ny, button = 0, clickCount = 1) {
    this.touch();
    this.#assertOpen();
    const { x, y } = this.#toPageCoords(nx, ny);
    const options = { button: MOUSE_BUTTONS[button] ?? 'left', clickCount: clampClickCount(clickCount) };
    await safeTimeout(this.#page.mouse.move(x, y), config.timeouts.action, 'mouse.move');
    await safeTimeout(this.#page.mouse.up(options), config.timeouts.action, 'mouse.up');
  }

  async click(nx, ny, { button = 0, clickCount = 1 } = {}) {
    this.touch();
    this.#assertOpen();
    const { x, y } = this.#toPageCoords(nx, ny);
    await safeTimeout(this.#page.mouse.move(x, y), config.timeouts.action, 'mouse.move');
    await safeTimeout(
      this.#page.mouse.click(x, y, { button: MOUSE_BUTTONS[button] ?? 'left', clickCount }),
      config.timeouts.action,
      'mouse.click',
    );
  }

  async wheel(nx, ny, deltaX = 0, deltaY = 0) {
    this.touch();
    this.#assertOpen();
    const { x, y } = this.#toPageCoords(nx, ny);
    await safeTimeout(this.#page.mouse.move(x, y), config.timeouts.action, 'mouse.move');
    await safeTimeout(this.#page.mouse.wheel(Number(deltaX) || 0, Number(deltaY) || 0), config.timeouts.action, 'mouse.wheel');
  }

  #mapKey(key) {
    if (typeof key !== 'string' || !key || IGNORED_KEYS.has(key)) return null;
    return KEY_ALIASES[key] ?? key;
  }

  async keyDown(key) {
    this.touch();
    this.#assertOpen();
    const mapped = this.#mapKey(key);
    if (!mapped) return;
    await safeTimeout(this.#page.keyboard.down(mapped), config.timeouts.action, 'keyboard.down');
  }

  async keyUp(key) {
    this.touch();
    this.#assertOpen();
    const mapped = this.#mapKey(key);
    if (!mapped) return;
    await safeTimeout(this.#page.keyboard.up(mapped), config.timeouts.action, 'keyboard.up');
  }

  /** Saisie de texte brut : collage, IME/accents composés, émojis. */
  async insertText(text) {
    this.touch();
    this.#assertOpen();
    const value = String(text ?? '').slice(0, 10_000);
    if (!value) return;
    await safeTimeout(this.#page.keyboard.insertText(value), config.timeouts.action, 'keyboard.insertText');
  }

  async setViewport(width, height) {
    this.touch();
    this.#assertOpen();
    const { minViewport: min, maxViewport: max } = config.session;
    const next = {
      width: Math.round(Math.min(max.width, Math.max(min.width, Number(width) || this.viewport.width))),
      height: Math.round(Math.min(max.height, Math.max(min.height, Number(height) || this.viewport.height))),
    };
    if (next.width === this.viewport.width && next.height === this.viewport.height) return this.viewport;
    this.viewport = next;
    await safeTimeout(this.#page.setViewportSize(next), config.timeouts.action, 'setViewportSize');
    await this.#restartStreamer();
    this.#scheduleState();
    return this.viewport;
  }

  // ---------------------------------------------------------------- state ---

  async state() {
    if (this.#closed || !this.#page || this.#page.isClosed()) {
      return {
        url: '',
        title: '',
        mode: this.#mode,
        viewport: this.viewport,
        stream: { ...this.streamOptions },
        preferences: { ...this.preferences },
        loading: false,
        closed: true,
      };
    }
    const title = await safeTimeout(this.#page.title(), 2_000, 'page.title');
    return {
      url: this.#page.url(),
      title: title ?? '',
      mode: this.#mode,
      viewport: this.viewport,
      stream: { ...this.streamOptions },
      preferences: { ...this.preferences },
      latency: { rtt: this.telemetry.rtt, excessMs: Math.round(this.telemetry.excessMs) },
      loading: false,
      closed: false,
    };
  }

  /** Regroupe les rafales d'événements de navigation en une seule notification. */
  #scheduleState() {
    if (this.#closed || this.#stateTimer) return;
    this.#stateTimer = setTimeout(async () => {
      this.#stateTimer = null;
      if (this.#closed) return;
      try {
        this.emit('state', await this.state());
      } catch {
        /* page en cours de navigation */
      }
    }, 120);
    if (typeof this.#stateTimer.unref === 'function') this.#stateTimer.unref();
  }

  #assertOpen() {
    if (this.#closed) throw new SessionClosedError('Session fermée.');
    if (!this.#page || this.#page.isClosed()) throw new SessionClosedError('Aucune page active dans cette session.');
  }

  stats() {
    return {
      id: this.id,
      owner: this.owner,
      instanceId: this.instanceId,
      mode: this.#mode,
      preferences: { ...this.preferences },
      createdAt: this.createdAt,
      lastUsed: this.lastUsed,
      idleMs: Date.now() - this.lastUsed,
      navigations: this.navigations,
      viewport: this.viewport,
      streamOptions: { ...this.streamOptions },
      stream: this.#streamer?.stats() ?? null,
      lastError: this.lastError,
    };
  }

  async close(reason = 'fermeture') {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#stateTimer);
    await this.#stopStreamer().catch(() => {});
    await this.#release().catch(() => {});
    this.emit('closed', { reason });
    this.removeAllListeners();
    log.info(`Session ${this.id} fermée (${reason}).`);
  }
}

export class NavigationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NavigationError';
  }
}

export class SessionClosedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionClosedError';
  }
}

/** Traduit les erreurs Chromium/Playwright en messages compréhensibles. */
function describeNavigationError(err, url) {
  const raw = err?.message ?? '';
  if (/Timeout|timeout/.test(raw)) return `Le site ${url} n'a pas répondu dans le délai imparti.`;
  if (/ERR_NAME_NOT_RESOLVED/.test(raw)) return `Nom de domaine introuvable : ${url}`;
  if (/ERR_CONNECTION_REFUSED/.test(raw)) return `Connexion refusée par ${url}.`;
  if (/ERR_CONNECTION_TIMED_OUT/.test(raw)) return `Connexion expirée vers ${url}.`;
  if (/ERR_CERT|SSL/.test(raw)) return `Certificat TLS invalide pour ${url}.`;
  if (/ERR_TOO_MANY_REDIRECTS/.test(raw)) return `Trop de redirections sur ${url} (souvent un blocage anti-bot).`;
  if (/ERR_BLOCKED_BY|ERR_ACCESS_DENIED/.test(raw)) return `Accès bloqué par ${url}.`;
  if (/net::/.test(raw)) return `Erreur réseau sur ${url} : ${raw.split('\n')[0]}`;
  return `Navigation impossible vers ${url} : ${raw.split('\n')[0]}`;
}

export default Session;
