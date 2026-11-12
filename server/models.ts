import type { MediaAsset, Job, Workspace } from '../shared/types.js';
export interface StoredAsset extends MediaAsset {
    storageKey: string;
    thumbnailKey?: string;
    sha256: string;
    activeJobId?: string | null;
    deleting?: boolean;
}
export interface StoredJob extends Job {
    workerId?: string;
    nextAttemptAt?: string;
    slotReserved?: boolean;
}
export interface StoredWorkspace extends Workspace {
    storageBytes: number;
    activeJobCount: number;
    deleting?: boolean;
}
export function publicAsset(asset: StoredAsset): MediaAsset { const { storageKey, thumbnailKey, sha256, activeJobId, deleting, ...safe } = asset; return safe; }
export function publicWorkspace(workspace: StoredWorkspace): Workspace { const { storageBytes, activeJobCount, deleting, ...safe } = workspace; return safe; }
