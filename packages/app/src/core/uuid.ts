/**
 * Context-safe UUID v4.
 *
 * `crypto.randomUUID()` only exists in a *secure context* (HTTPS or
 * localhost/127.0.0.1). When the app is served over plain HTTP from a LAN
 * address — e.g. a VM reached at `http://10.0.2.15:5173` from the host — it is
 * undefined and throws. `crypto.getRandomValues()` is available everywhere, so
 * fall back to a hand-built v4, and finally to Math.random() if even that is
 * missing.
 */
export function uuid(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);

  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return (
    h.slice(0, 4).join('') +
    '-' +
    h.slice(4, 6).join('') +
    '-' +
    h.slice(6, 8).join('') +
    '-' +
    h.slice(8, 10).join('') +
    '-' +
    h.slice(10, 16).join('')
  );
}
