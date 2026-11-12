import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getAuth } from 'firebase-admin/auth';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { store } from './store.js';
import { HttpError } from './errors.js';
import type { User, Role } from '../shared/types.js';
const scrypt = promisify(scryptCallback);
export const sessionCookie = 'creatorflow_session';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const credentialId = (email: string) => hash(email.toLowerCase());
export async function hashPassword(password: string) { const salt = randomBytes(16).toString('hex'); const key = await scrypt(password, salt, 64) as Buffer; return `${salt}:${key.toString('hex')}`; }
export async function verifyPassword(password: string, passwordHash: string) { const [salt, key] = passwordHash.split(':'); const actual = await scrypt(password, salt, 64) as Buffer; const expected = Buffer.from(key, 'hex'); return actual.length === expected.length && timingSafeEqual(actual, expected); }
export function setSessionCookie(res: Response, token: string) { res.cookie(sessionCookie, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: config.sessionTtlMs, path: '/' }); }
export async function createLocalSession(res: Response, userId: string) {
    const token = randomBytes(32).toString('base64url');
    await store.put('sessions', { id: hash(token), userId, expiresAt: new Date(Date.now() + config.sessionTtlMs).toISOString() });
    setSessionCookie(res, token);
}
export async function deleteSession(req: Request, res: Response) { const token = req.cookies?.[sessionCookie]; if (config.mode === 'local' && token)
    await store.remove('sessions', hash(token)); res.clearCookie(sessionCookie, { path: '/' }); }
declare global {
    namespace Express {
        interface Request {
            user?: User;
            role?: Role;
        }
    }
}
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
    try {
        const cookie = req.cookies?.[sessionCookie];
        const authorization = req.headers.authorization;
        if (config.mode === 'firebase') {
            const decoded = cookie ? await getAuth().verifySessionCookie(cookie, true) : authorization?.startsWith('Bearer ') ? await getAuth().verifyIdToken(authorization.slice(7), true) : null;
            if (!decoded)
                throw new HttpError(401, 'Sign in to continue.', 'AUTH_REQUIRED');
            const user = { id: decoded.uid, name: decoded.name || decoded.email?.split('@')[0] || 'Creator', email: decoded.email || '' };
            req.user = user;
            const profile = await store.get<any>('users', user.id);
            if (profile?.deleting)
                throw new HttpError(401, 'This account is being deleted.');
            if (!profile)
                await store.put('users', { ...user, createdAt: new Date().toISOString() });
        }
        else {
            if (!cookie)
                throw new HttpError(401, 'Sign in to continue.', 'AUTH_REQUIRED');
            const session = await store.get<any>('sessions', hash(cookie));
            if (!session || Date.parse(session.expiresAt) < Date.now())
                throw new HttpError(401, 'Your session has expired. Please sign in again.', 'AUTH_REQUIRED');
            const user = await store.get<User>('users', session.userId);
            if (!user)
                throw new HttpError(401, 'Sign in to continue.', 'AUTH_REQUIRED');
            if ((user as any).deleting)
                throw new HttpError(401, 'This account is being deleted.');
            req.user = { id: user.id, name: user.name, email: user.email };
        }
        next();
    }
    catch (error) {
        next(error instanceof HttpError ? error : new HttpError(401, 'Your session has expired. Please sign in again.', 'AUTH_REQUIRED'));
    }
}
export function workspaceAccess(roles: Role[] = ['owner', 'administrator', 'editor', 'viewer']) {
    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            const workspaceId = String(req.params.workspaceId || '');
            const membership = await store.get<any>('memberships', `${workspaceId}_${req.user!.id}`);
            if (!membership || !roles.includes(membership.role))
                throw new HttpError(403, 'You do not have permission to access this workspace.', 'FORBIDDEN');
            const workspace = await store.get<any>('workspaces', workspaceId);
            if (!workspace)
                throw new HttpError(404, 'Workspace not found.', 'NOT_FOUND');
            if (workspace.deleting && !(req.method === 'DELETE' && !req.params.assetId))
                throw new HttpError(409, 'This workspace is being deleted.');
            req.role = membership.role;
            next();
        }
        catch (error) {
            next(error);
        }
    };
}
