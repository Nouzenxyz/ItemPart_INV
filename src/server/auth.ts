import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { db } from './db';

export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role: 'admin' | 'staff' | 'viewer';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const SESSION_HOURS = 12;

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(
    token,
    userId,
    Date.now() + SESSION_HOURS * 3600 * 1000
  );
  return token;
}

export function destroySession(token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.sid as string | undefined;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  const user = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(token, Date.now()) as AuthUser | undefined;
  if (!user) return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
  req.user = user;
  next();
}

export function requireRole(...roles: AuthUser['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your account is not allowed to do this.' });
    }
    next();
  };
}
