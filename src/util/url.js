import dns from 'node:dns/promises';
import net from 'node:net';
import config from '../config.js';
import { safeTimeout } from './withTimeout.js';

export class InvalidUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidUrlError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'metadata', 'metadata.google.internal']);

function ipv4IsPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + métadonnées cloud (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / réservé
  return false;
}

function ipv6IsPrivate(ip) {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fe80') || addr.startsWith('fc') || addr.startsWith('fd')) return true;
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  return false;
}

export function isPrivateAddress(host) {
  const version = net.isIP(host);
  if (version === 4) return ipv4IsPrivate(host);
  if (version === 6) return ipv6IsPrivate(host);
  return false;
}

/**
 * Normalise une saisie utilisateur : « google.com » -> « https://google.com/ ».
 * Une saisie qui n'a rien d'une URL est transformée en recherche DuckDuckGo.
 */
export function normalizeInput(raw, { searchTemplate } = {}) {
  const input = String(raw ?? '').trim();
  if (!input) throw new InvalidUrlError('URL vide.');
  if (input.length > 2048) throw new InvalidUrlError('URL trop longue (max 2048 caractères).');

  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  const looksLikeHost = /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(input);

  if (looksLikeUrl) return input;
  if (looksLikeHost) return `https://${input}`;
  const template = searchTemplate || 'https://duckduckgo.com/?q=%s';
  return template.replace('%s', encodeURIComponent(input));
}

/**
 * Validation complète : protocole autorisé, hôte présent, pas d'IP privée
 * (protection anti-SSRF : le navigateur tourne sur le VPS et pourrait
 * autrement atteindre les services internes ou l'endpoint de métadonnées).
 */
export async function validateUrl(raw, { resolveDns = true, searchTemplate } = {}) {
  let url;
  try {
    url = new URL(normalizeInput(raw, { searchTemplate }));
  } catch {
    throw new InvalidUrlError('URL invalide.');
  }

  if (!config.security.allowedProtocols.includes(url.protocol)) {
    throw new InvalidUrlError(`Protocole non autorisé (${url.protocol}). Seuls http et https sont acceptés.`);
  }
  if (!url.hostname) throw new InvalidUrlError('Nom d’hôte manquant.');

  if (config.security.blockPrivateHosts) {
    const host = url.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
      throw new InvalidUrlError('Accès aux hôtes locaux/internes interdit.');
    }
    if (isPrivateAddress(host)) {
      throw new InvalidUrlError('Accès aux adresses IP privées interdit.');
    }
    if (resolveDns && net.isIP(host) === 0) {
      const records = await safeTimeout(
        dns.lookup(host, { all: true }),
        config.security.dnsTimeoutMs,
        `dns:${host}`,
      );
      // Une résolution qui échoue/expire n'est pas bloquante : Playwright renverra
      // l'erreur réseau réelle. En revanche une IP privée résolue est refusée.
      if (records?.some((r) => isPrivateAddress(r.address))) {
        throw new InvalidUrlError('Ce nom de domaine pointe vers une adresse privée.');
      }
    }
  }

  return url.toString();
}

export default validateUrl;
