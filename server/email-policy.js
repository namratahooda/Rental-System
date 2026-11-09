export const institutionalDomain = 'iiita.ac.in';

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isInstitutionalEmail(value) {
  const email = normalizeEmail(value);
  const separator = email.lastIndexOf('@');
  return separator > 0 && email.slice(separator + 1) === institutionalDomain;
}
