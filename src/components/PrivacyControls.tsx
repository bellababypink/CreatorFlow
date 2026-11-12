import { useState, type FormEvent } from 'react';
import { ArrowDownToLine, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react';
import type { SystemStatus, User, Workspace } from '../../shared/types';
import { api } from '../api';
import Modal from './Modal';

export default function PrivacyControls({ user, workspace, workspaces, status, notify, onWorkspaceDeleted, onAccountDeleted }: {
  user: User; workspace: Workspace | null; workspaces: Workspace[]; status: SystemStatus | null;
  notify: (message: string) => void; onWorkspaceDeleted: () => Promise<void>; onAccountDeleted: () => void;
}) {
  const [deletion, setDeletion] = useState<'workspace' | 'account' | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ownedWorkspaces = workspaces.filter(w => w.role === 'owner');
  const expected = deletion === 'workspace' ? workspace?.name : user.email;
  const open = (kind: 'workspace' | 'account') => { setConfirmation(''); setPassword(''); setError(''); setDeletion(kind); };
  const remove = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      let idToken: string | undefined;
      if (deletion === 'account' && status?.mode === 'firebase') {
        if (!status.firebaseConfig) throw new Error('Firebase sign-in is unavailable.');
        const [{ getApps, initializeApp }, { getAuth, GoogleAuthProvider, signInWithPopup, signOut }] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
        const auth = getAuth(getApps()[0] || initializeApp(status.firebaseConfig));
        try { const login = await signInWithPopup(auth, new GoogleAuthProvider()); idToken = await login.user.getIdToken(true); }
        finally { await signOut(auth); }
      }
      await api(deletion === 'workspace' ? `/workspaces/${workspace!.id}` : '/account', {
        method: 'DELETE', body: JSON.stringify({ confirmation, ...(password ? { password } : {}), ...(idToken ? { idToken } : {}) }),
      });
      setDeletion(null);
      if (deletion === 'workspace') { await onWorkspaceDeleted(); notify('The workspace and its stored media have been deleted.'); }
      else { onAccountDeleted(); notify('Your account has been deleted.'); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const exportAccount = async () => {
    try {
      const records = await api('/account/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'creatorflow-account.json'; anchor.click(); URL.revokeObjectURL(url);
      notify('Account records downloaded. Export each workspace separately for its media analysis records.');
    } catch (e) { notify((e as Error).message); }
  };
  return <section className="panel privacy-panel">
    <div className="section-heading"><div><span className="eyebrow">YOUR DATA, YOUR CONTROL</span><h2>Privacy & account controls</h2></div><ShieldCheck size={22}/></div>
    <p>Download your records, delete a workspace, or remove your account. Original videos can be downloaded from their Media Vault pages.</p>
    <div className="privacy-actions">
      <button className="button secondary" onClick={exportAccount}><ArrowDownToLine size={15}/>Export account records</button>
      {workspace?.role === 'owner' && <button className="button secondary" onClick={() => open('workspace')}><Trash2 size={15}/>Delete this workspace</button>}
      <button className="button secondary" onClick={() => open('account')} disabled={ownedWorkspaces.length > 0}><Trash2 size={15}/>Delete account</button>
    </div>
    {ownedWorkspaces.length > 0 && <p className="fine-print">Delete your owned workspaces before deleting your account. Active processing must finish before a workspace can be deleted.</p>}
    {deletion && <Modal title={`Delete ${deletion}`} close={() => { if (!busy) setDeletion(null); }}>
      <span className="eyebrow">PERMANENT DELETION</span><h2>{deletion === 'workspace' ? 'Delete this creative space?' : 'Close your account?'}</h2>
      <p>{deletion === 'workspace' ? 'This permanently deletes the workspace, original media, analysis, memberships, and jobs. Download anything you want to keep first.' : 'This permanently deletes your account and memberships. You will need to verify your identity to continue.'}</p>
      <form onSubmit={remove}>
        <label>Type “{expected}” to confirm<input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" required/></label>
        {deletion === 'account' && status?.mode === 'local' && <label>Your password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required/></label>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button primary full" disabled={busy || confirmation !== expected}>{busy ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}Permanently delete {deletion}</button>
      </form>
    </Modal>}
  </section>;
}
