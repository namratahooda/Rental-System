import test from 'node:test';
import assert from 'node:assert/strict';
import { isInstitutionalEmail, normalizeEmail } from './email-policy.js';

test('accepts a normalized exact IIITA email domain', () => {
  assert.equal(isInstitutionalEmail('student@iiita.ac.in'), true);
  assert.equal(isInstitutionalEmail('  STUDENT@IIITA.AC.IN  '), true);
  assert.equal(normalizeEmail('  STUDENT@IIITA.AC.IN  '), 'student@iiita.ac.in');
});

test('external email domains never receive direct institutional access', () => {
  for (const email of [
    'student@gmail.com',
    'student@outlook.com',
    'student@fake-iiita.ac.in',
    'student@iiita.ac.in.example.com',
    'student@iiita.com'
  ]) {
    assert.equal(isInstitutionalEmail(email), false, `${email} should require external approval`);
  }
});
