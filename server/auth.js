import crypto from 'node:crypto';
import { prisma } from './db.js';
const sessions = new Map();
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 });
  return token;
}
export function clearSession(token) { if (token) sessions.delete(token); }
export async function optionalAuth(req, res, next) {
  try {
    const token = req.cookies?.rentol_session;
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) { if (token) sessions.delete(token); return next(); }
    req.user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (req.user && (!req.user.isApproved || req.user.suspended)) req.user = null;
    next();
  } catch (error) { next(error); }
}
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  next();
}
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}
export const publicUser = ({ passwordHash, ...user }) => user;
