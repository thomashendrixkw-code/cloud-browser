import crypto from 'node:crypto';

/**
 * Jeton de session signé (HMAC-SHA256), sans état côté serveur :
 * `base64url(payload).base64url(signature)`.
 *
 * Volontairement minimal — il n'y a rien à révoquer individuellement pour 1 à 3
 * utilisateurs : changer AUTH_SECRET invalide tous les jetons d'un coup.
 */
export function signToken(payload, secret, ttlMs) {
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlMs };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, signature] = token.split('.', 2);
  if (!data || !signature) return null;

  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  // Comparaison à temps constant : jamais d'égalité de chaînes sur une signature.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Comparaison de secrets à temps constant, insensible à la différence de longueur. */
export function secretsMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Analyse l'en-tête Cookie sans dépendance externe. */
export function parseCookies(header) {
  const jar = new Map();
  if (typeof header !== 'string') return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) jar.set(name, decodeURIComponent(value));
  }
  return jar;
}
