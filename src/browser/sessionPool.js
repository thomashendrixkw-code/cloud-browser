import crypto from 'node:crypto';
import config from '../config.js';
import { createLogger } from '../logger.js';
import Session from './session.js';

const log = createLogger('pool');

export class UserSessionLimitError extends Error {
  constructor(max) {
    super(`Vous avez déjà ${max} session(s) ouverte(s). Fermez-en une avant d'en ouvrir une autre.`);
    this.name = 'UserSessionLimitError';
    this.max = max;
  }
}

export class SessionLimitError extends Error {
  constructor(max) {
    super(`Limite de ${max} session(s) simultanée(s) atteinte. Réessayez dans quelques minutes.`);
    this.name = 'SessionLimitError';
    this.max = max;
  }
}

/**
 * Pool de sessions : Map userId -> Session ({ context, page, lastUsed }).
 * Applique la limite de sessions simultanées et le nettoyage sur inactivité.
 */
export class SessionPool {
  #sessions = new Map();
  #sweepTimer = null;

  constructor(browserManager) {
    this.browserManager = browserManager;
  }

  start() {
    this.#sweepTimer = setInterval(() => this.sweep(), config.session.sweepIntervalMs);
    if (typeof this.#sweepTimer.unref === 'function') this.#sweepTimer.unref();
    return this;
  }

  get size() {
    return this.#sessions.size;
  }

  get(id) {
    const session = this.#sessions.get(id);
    // Les emplacements réservés (création en cours) ne sont jamais exposés.
    if (!session || session.placeholder) return undefined;
    if (!session.closed) return session;
    this.#sessions.delete(id);
    return undefined;
  }

  has(id) {
    return Boolean(this.get(id));
  }

  countFor(owner) {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (!session.placeholder && !session.closed && session.owner === owner) count += 1;
    }
    return count;
  }

  async create(owner, { deviceScaleFactor, searchEngine } = {}) {
    if (this.#sessions.size >= config.session.max) throw new SessionLimitError(config.session.max);
    // Quota individuel : empêche un compte d'accaparer toutes les places.
    const perUser = config.session.maxPerUser;
    if (perUser > 0 && this.countFor(owner) >= perUser) throw new UserSessionLimitError(perUser);

    const id = crypto.randomBytes(16).toString('hex');
    // Réservation immédiate de la place pour éviter la course entre deux créations.
    this.#sessions.set(id, { closed: false, placeholder: true });

    let lease;
    try {
      lease = await this.browserManager.acquireContext({
        viewport: { ...config.session.viewport },
        deviceScaleFactor: Math.min(
          config.session.maxDeviceScaleFactor,
          Math.max(1, Number(deviceScaleFactor) || config.session.deviceScaleFactor),
        ),
        userAgent: config.session.userAgent,
        locale: config.session.locale,
        timezoneId: config.session.timezoneId,
        acceptDownloads: false,
        bypassCSP: false,
        javaScriptEnabled: true,
      });

      const session = new Session({
        id,
        context: lease.context,
        release: lease.release,
        instanceId: lease.instanceId,
        owner,
        deviceScaleFactor: Number(deviceScaleFactor) || config.session.deviceScaleFactor,
        searchEngine,
      });
      session.once('closed', () => this.#sessions.delete(id));
      await session.init();
      this.#sessions.set(id, session);
      log.info(`Session ${id} créée pour « ${owner} » (${this.#sessions.size}/${config.session.max}).`);
      return session;
    } catch (err) {
      this.#sessions.delete(id);
      await lease?.release?.().catch(() => {});
      throw err;
    }
  }

  async destroy(id, reason = 'demande utilisateur') {
    const session = this.get(id);
    if (!session) return false;
    this.#sessions.delete(id);
    await session.close(reason);
    return true;
  }

  /** Ferme les BrowserContexts inactifs depuis plus de SESSION_IDLE_MINUTES. */
  sweep() {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.placeholder) continue;
      if (session.closed) {
        this.#sessions.delete(id);
        continue;
      }
      if (now - session.lastUsed > config.session.idleTimeoutMs) {
        log.info(`Session ${id} inactive depuis ${Math.round((now - session.lastUsed) / 1000)}s : fermeture.`);
        this.#sessions.delete(id);
        session.close('inactivité').catch(() => {});
      }
    }
  }

  stats() {
    return {
      count: this.#sessions.size,
      max: config.session.max,
      idleTimeoutMs: config.session.idleTimeoutMs,
      sessions: [...this.#sessions.values()].filter((s) => !s.placeholder).map((s) => s.stats()),
    };
  }

  async shutdown() {
    clearInterval(this.#sweepTimer);
    const sessions = [...this.#sessions.values()].filter((s) => !s.placeholder);
    this.#sessions.clear();
    await Promise.all(sessions.map((s) => s.close('arrêt du serveur').catch(() => {})));
  }
}

export default SessionPool;
