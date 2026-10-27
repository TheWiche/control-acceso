import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

/** Reloj reactivo para contadores ("hace 12 s", cuenta regresiva). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ---------------- Toasts ---------------- */
type ToastKind = 'ok' | 'warn' | 'err' | 'info';
interface ToastItem { id: number; kind: ToastKind; title: string; text?: string }
const ToastCtx = createContext<{ push: (t: Omit<ToastItem, 'id'>, ms?: number) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

const toastIcon = { ok: CheckCircle2, warn: AlertTriangle, err: XCircle, info: Info };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<ToastItem, 'id'>, ms = 5000) => {
    const id = ++seq.current;
    setItems((x) => [...x.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), ms);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => {
          const Icon = toastIcon[t.kind];
          return (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <Icon size={18} aria-hidden />
              <div>
                <strong>{t.title}</strong>
                {t.text && <p>{t.text}</p>}
              </div>
              <button className="icon-btn" aria-label="Cerrar" onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}><X size={16} /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- Modal / bottom sheet ---------------- */
export function Modal({ title, onClose, children, footer, wide = false, dismissable = true }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissable) onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      prev?.focus?.();
    };
  }, [onClose, dismissable]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && dismissable) onClose(); }}>
      <div className={`sheet ${wide ? 'sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <header className="sheet-head">
          <h2>{title}</h2>
          {dismissable && <button className="icon-btn" aria-label="Cerrar" onClick={onClose}><X size={20} /></button>}
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmModal({ title, text, confirmLabel, danger, onConfirm, onClose }: {
  title: string; text: string; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy}
          onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); onClose(); } }}>
          {busy ? <Spinner /> : confirmLabel}
        </button>
      </>}>
      <p className="muted">{text}</p>
    </Modal>
  );
}

/* ---------------- Átomos ---------------- */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export const Spinner = () => <span className="spinner" aria-label="Cargando" />;

export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}

export function SignalBars({ bars }: { bars: number }) {
  return (
    <span className="signal" aria-label={`Señal ${bars} de 4`}>
      {[1, 2, 3, 4].map((i) => <i key={i} className={i <= bars ? 'on' : ''} style={{ height: 4 + i * 3 }} />)}
    </span>
  );
}
