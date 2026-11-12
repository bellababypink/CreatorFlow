import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} onCancel={close} className={`modal ${wide ? 'wide' : ''}`} aria-label={title} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <button className="icon-button modal-close" onClick={close} aria-label="Close dialog"><X size={20}/></button>
    {children}
  </dialog>;
}
