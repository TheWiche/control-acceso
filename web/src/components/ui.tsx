import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronsRight, Info, LockOpen, X, XCircle } from 'lucide-react';

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
  // onClose suele ser una función nueva en cada render (y hay modales que se redibujan cada 250 ms por su
  // cuenta atrás). Si el efecto dependiera de ella, se repetiría en cada render y robaría el foco al campo
  // en el que se está escribiendo. Por eso el foco solo se mueve al abrir y al cerrar.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissable);
  dismissRef.current = dismissable;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissRef.current) closeRef.current(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      prev?.focus?.();
    };
  }, []);
  // Móvil: la hoja se arrastra hacia abajo desde el asa o el encabezado y se cierra al soltar pasado el umbral.
  const [dragY, setDragY] = useState<number | null>(null);
  const drag = useRef<{ y0: number } | null>(null);
  const onDragStart = (e: React.PointerEvent) => {
    if (!dismissable || !window.matchMedia('(max-width: 640px)').matches) return;
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { y0: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragY(0);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (drag.current) setDragY(Math.max(0, e.clientY - drag.current.y0));
  };
  const onDragEnd = () => {
    if (!drag.current) return;
    const far = (dragY ?? 0) > 90;
    drag.current = null;
    if (far) closeRef.current(); else setDragY(null);
  };
  const dragProps = { onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && dismissable) onClose(); }}>
      <div className={`sheet ${wide ? 'sheet-wide' : ''} ${drag.current ? 'dragging' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}>
        {dismissable && <div className="sheet-grab" aria-hidden {...dragProps}><i /></div>}
        <header className="sheet-head" {...dragProps}>
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

/* ---------------- Deslizador de apertura ---------------- */
export type SlideState = 'idle' | 'verifying' | 'unlocked' | 'error';

/**
 * "Desliza para abrir". Un toque suelto no hace nada (evita aperturas por error); hay que arrastrar el tirador
 * más del 88 % del recorrido. Con teclado, Enter/Espacio sobre el tirador equivale a completar el gesto.
 */
export function SlideToUnlock({ state, label, disabled, lockdown, onComplete }: {
  state: SlideState; label: string; disabled?: boolean; lockdown?: boolean; onComplete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; w: number } | null>(null);
  const [p, setP] = useState(0);
  const [dragging, setDragging] = useState(false);
  const locked = disabled || state !== 'idle';
  const shown = state === 'verifying' || state === 'unlocked' ? 1 : dragging ? p : 0;

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (locked || !ref.current) return;
    start.current = { x: e.clientX, w: ref.current.clientWidth - 62 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true); setP(0);
  };
  const move = (e: React.PointerEvent) => {
    if (!start.current) return;
    setP(Math.min(1, Math.max(0, (e.clientX - start.current.x) / start.current.w)));
  };
  const up = () => {
    if (!start.current) return;
    const done = p >= 0.88;
    start.current = null; setDragging(false); setP(0);
    if (done) { navigator.vibrate?.(14); onComplete(); }
  };

  return (
    <div ref={ref} className={`slide ${state}${dragging ? ' dragging' : ''}${locked ? ' disabled' : ''}${lockdown ? ' lockdown' : ''}`}
      style={{ '--p': shown } as React.CSSProperties}>
      <div className="slide-fill" />
      <span className="slide-label" aria-live="polite">{label}</span>
      <button type="button" className="slide-handle" disabled={locked} aria-label={label}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onClick={(e) => { if (e.detail === 0 && !locked) onComplete(); }}>
        {state === 'verifying' ? <Spinner /> : state === 'unlocked' ? <LockOpen size={22} aria-hidden /> : state === 'error' ? <X size={22} aria-hidden /> : <ChevronsRight size={24} aria-hidden />}
      </button>
    </div>
  );
}
