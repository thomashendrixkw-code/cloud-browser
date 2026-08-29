import config from '../config.js';
import { createLogger } from '../logger.js';
import { safeTimeout, withTimeout } from '../util/withTimeout.js';

const log = createLogger('screencast');

/**
 * Approche « avancée » : CDP Page.startScreencast.
 * Chromium pousse une frame JPEG à chaque changement visuel ; chaque frame doit
 * être acquittée (Page.screencastFrameAck) sinon le navigateur cesse d'émettre.
 * On acquitte TOUJOURS, même quand on décide de ne pas transmettre la frame au
 * client (backpressure) : c'est ce qui évite d'engorger la connexion.
 */
export class ScreencastStreamer {
  static mode = 'screencast';

  #context;
  #page;
  #cdp = null;
  #onFrame;
  #canSend;
  #running = false;
  #frames = 0;
  #dropped = 0;

  constructor({
    context,
    page,
    onFrame,
    canSend = () => true,
    quality = config.stream.jpegQuality,
    scale = config.session.deviceScaleFactor,
  }) {
    this.#context = context;
    this.#page = page;
    this.#onFrame = onFrame;
    this.#canSend = canSend;
    this.quality = quality;
    this.scale = scale;
  }

  get mode() {
    return ScreencastStreamer.mode;
  }

  async start() {
    if (this.#running) return;
    this.#running = true;

    this.#cdp = await withTimeout(this.#context.newCDPSession(this.#page), config.timeouts.action, 'newCDPSession');

    this.#cdp.on('Page.screencastFrame', async (frame) => {
      // Accusé de réception systématique et immédiat.
      try {
        await this.#cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      } catch {
        /* session CDP fermée entre-temps */
      }
      if (!this.#running) return;
      this.#frames += 1;
      if (!this.#canSend()) {
        this.#dropped += 1;
        return;
      }
      this.#onFrame(Buffer.from(frame.data, 'base64'), frame.metadata);
    });

    const { width, height } = this.#page.viewportSize() ?? config.session.viewport;
    await withTimeout(
      this.#cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.quality,
        maxWidth: Math.round(width * this.scale),
        maxHeight: Math.round(height * this.scale),
        everyNthFrame: 1,
      }),
      config.timeouts.action,
      'Page.startScreencast',
    );
    log.debug('Screencast démarré.');
  }

  /** Rejoue startScreencast avec la nouvelle qualité, sans redétacher le CDP. */
  async setQuality(quality) {
    this.quality = quality;
    if (!this.#running || !this.#cdp) return;
    await safeTimeout(this.#cdp.send('Page.stopScreencast'), config.timeouts.action, 'Page.stopScreencast');
    const { width, height } = this.#page.viewportSize() ?? config.session.viewport;
    await safeTimeout(
      this.#cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.quality,
        maxWidth: Math.round(width * this.scale),
        maxHeight: Math.round(height * this.scale),
        everyNthFrame: 1,
      }),
      config.timeouts.action,
      'Page.startScreencast',
    );
  }

  async stop() {
    if (!this.#running) return;
    this.#running = false;
    if (this.#cdp) {
      await safeTimeout(this.#cdp.send('Page.stopScreencast'), config.timeouts.action, 'Page.stopScreencast');
      await safeTimeout(this.#cdp.detach(), config.timeouts.action, 'cdp.detach');
      this.#cdp = null;
    }
    log.debug(`Screencast arrêté (${this.#frames} frames, ${this.#dropped} ignorées).`);
  }

  stats() {
    return { mode: this.mode, frames: this.#frames, dropped: this.#dropped };
  }
}

export default ScreencastStreamer;
