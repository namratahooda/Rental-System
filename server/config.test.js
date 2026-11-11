import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfig } from './config.js';

test('runtime configuration requires SQLite and a valid listener port', () => {
  assert.throws(() => validateRuntimeConfig({}), /DATABASE_URL is required/);
  assert.throws(() => validateRuntimeConfig({ DATABASE_URL: 'postgres://example' }), /SQLite/);
  assert.throws(() => validateRuntimeConfig({ DATABASE_URL: 'file:./db.sqlite', PORT: '70000' }), /PORT/);
  assert.deepEqual(validateRuntimeConfig({ DATABASE_URL: 'file:./db.sqlite', PORT: '4123' }), { port: 4123, clientOrigin: 'http://localhost:5173' });
});

test('production requires HTTPS origins and complete Google OAuth configuration', () => {
  const base = { DATABASE_URL: 'file:./prod.sqlite', NODE_ENV: 'production', PORT: '4000' };
  assert.throws(() => validateRuntimeConfig(base), /CLIENT_ORIGIN/);
  assert.throws(() => validateRuntimeConfig({ ...base, CLIENT_ORIGIN: 'http://rentol.example' }), /HTTPS/);
  assert.throws(() => validateRuntimeConfig({ ...base, CLIENT_ORIGIN: 'https://rentol.example', GOOGLE_CLIENT_ID: 'id' }), /both GOOGLE/);
  assert.throws(() => validateRuntimeConfig({ ...base, CLIENT_ORIGIN: 'https://rentol.example', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }), /GOOGLE_CALLBACK_URL/);
  assert.deepEqual(validateRuntimeConfig({ ...base, CLIENT_ORIGIN: 'https://rentol.example', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_CALLBACK_URL: 'https://api.rentol.example/api/auth/google/callback' }), { port: 4000, clientOrigin: 'https://rentol.example' });
});
