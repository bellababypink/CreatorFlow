import type { SystemStatus } from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init, credentials: 'same-origin',
    headers: { ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message || `Request failed (${response.status})`, response.status);
  }
  return response.status === 204 ? undefined as T : response.json();
}
export async function googleSignIn(status: SystemStatus) {
  if (!status.firebaseConfig || !status.authConfigured || status.mode !== 'firebase') {
    throw new Error('Google sign-in needs Firebase configuration. Use a local development account to try this installation.');
  }
  const [{ initializeApp, getApps }, { getAuth, GoogleAuthProvider, signInWithPopup, signOut }] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  const app = getApps()[0] || initializeApp(status.firebaseConfig);
  const auth = getAuth(app);
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  const idToken = await result.user.getIdToken(true);
  await api('/auth/firebase', { method: 'POST', body: JSON.stringify({ idToken }) });
  await signOut(auth);
}
export const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
export const formatSize = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
