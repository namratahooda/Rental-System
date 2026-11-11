export function validateRuntimeConfig(env = process.env) {
  if (!env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required.');
  if (!env.DATABASE_URL.startsWith('file:')) throw new Error('This Rentol build uses a SQLite DATABASE_URL beginning with file:.');
  const port = Number(env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const production = env.NODE_ENV === 'production';
  const clientOrigin = env.CLIENT_ORIGIN || (production ? '' : 'http://localhost:5173');
  if (production && !clientOrigin) throw new Error('CLIENT_ORIGIN must be set in production.');
  if (clientOrigin) {
    let parsed;
    try { parsed = new URL(clientOrigin); } catch { throw new Error('CLIENT_ORIGIN must be a valid origin URL.'); }
    if (parsed.origin !== clientOrigin.replace(/\/$/, '')) throw new Error('CLIENT_ORIGIN must contain only the origin, without a path.');
    if (production && parsed.protocol !== 'https:') throw new Error('CLIENT_ORIGIN must use HTTPS in production.');
  }
  const hasGoogleId = Boolean(env.GOOGLE_CLIENT_ID?.trim());
  const hasGoogleSecret = Boolean(env.GOOGLE_CLIENT_SECRET?.trim());
  if (hasGoogleId !== hasGoogleSecret) throw new Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or leave both empty.');
  if (production && hasGoogleId) {
    if (!env.GOOGLE_CALLBACK_URL) throw new Error('GOOGLE_CALLBACK_URL must be set when Google OAuth is enabled in production.');
    let callback;
    try { callback = new URL(env.GOOGLE_CALLBACK_URL); } catch { throw new Error('GOOGLE_CALLBACK_URL must be a valid URL.'); }
    if (callback.protocol !== 'https:') throw new Error('GOOGLE_CALLBACK_URL must use HTTPS in production.');
  }
  return { port, clientOrigin };
}
