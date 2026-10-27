import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Ban, CalendarClock, Check, CircleSlash, Clock, Delete, DoorClosed, KeyRound, LockKeyhole, LockKeyholeOpen,
  RefreshCw, ShieldAlert, TimerOff, WifiOff,
} from 'lucide-react';
import { previewPass, redeemPass, type PassPreview } from '../lib/guestApi';
import { daysText, usesText } from '../lib/share';
import { fmtDateTime } from '../lib/format';
import { Spinner } from '../components/ui';

type View =
  | { k: 'loading' }
  | { k: 'network'; msg: string }
  | { k: 'blocked'; reason: string }
  | { k: 'ready' }
  | { k: 'sending' }
  | { k: 'open'; usesLeft: number | null; unlockMs: number }
  | { k: 'denied'; reason: string };

/** Estado de la vista previa -> motivo (mismas claves que el canje). */
const STATUS_TO_REASON: Record<string, string> = {
  invalid: 'pass_invalid', revoked: 'pass_revoked', expired: 'pass_expired', not_yet: 'pass_not_yet_valid',
  exhausted: 'pass_exhausted', locked: 'pass_locked', outside_schedule: 'outside_schedule',
};

const RETRYABLE = new Set(['device_offline', 'device_unreachable', 'door_no_response', 'rate_limited']);

function describe(reason: string, p: PassPreview | null): { title: string; text: string; Icon: typeof Ban } {
  switch (reason) {
    case 'pass_expired': return { title: 'Acceso expirado', text: p?.valid_until ? `Este acceso venció el ${fmtDateTime(p.valid_until)}.` : 'Este acceso ya venció.', Icon: TimerOff };
    case 'pass_revoked': return { title: 'Acceso revocado', text: 'Quien te lo compartió lo canceló.', Icon: Ban };
    case 'pass_exhausted': return { title: 'Sin usos disponibles', text: 'Este acceso ya alcanzó su límite de usos.', Icon: CircleSlash };
    case 'pass_not_yet_valid': return { title: 'Aún no está activo', text: p?.valid_from ? `Podrás usarlo desde el ${fmtDateTime(p.valid_from)}.` : 'Todavía no comienza su vigencia.', Icon: CalendarClock };
    case 'outside_schedule': return {
      title: 'Fuera de horario',
      text: `Este acceso solo funciona ${p?.time_start && p.time_end ? `de ${p.time_start} a ${p.time_end}, ` : ''}${daysText(p?.allowed_days ?? null).toLowerCase()}.`,
      Icon: Clock,
    };
    case 'pass_locked': return { title: 'Bloqueado temporalmente', text: 'Hubo demasiados PIN incorrectos. Intenta de nuevo en 15 minutos.', Icon: LockKeyhole };
    case 'rate_limited': return { title: 'Demasiados intentos', text: 'Espera unos minutos e inténtalo otra vez.', Icon: ShieldAlert };
    case 'lockdown': return { title: 'Puerta no disponible', text: 'El acceso está bloqueado temporalmente por el administrador.', Icon: ShieldAlert };
    case 'device_offline':
    case 'device_unreachable':
    case 'door_no_response': return { title: 'La cerradura no respondió', text: 'No se descontó ningún uso. Acércate a la puerta e inténtalo de nuevo.', Icon: WifiOff };
    case 'pass_wrong_device':
    case 'device_inactive': return { title: 'Esta puerta no está incluida', text: 'Tu acceso no aplica a esta puerta.', Icon: DoorClosed };
    default: return { title: 'Enlace no válido', text: 'Este enlace no existe o fue reemplazado. Pide uno nuevo a quien te invitó.', Icon: Ban };
  }
}

export function GuestKey() {
  const { token = '' } = useParams();
  const [search] = useSearchParams();
  const wantedDoor = search.get('d');

  const [view, setView] = useState<View>({ k: 'loading' });
  const [preview, setPreview] = useState<PassPreview | null>(null);
  const [door, setDoor] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const sending = useRef(false);

  useEffect(() => {
    document.title = 'Llave digital';
    const robots = document.createElement('meta');
    robots.name = 'robots'; robots.content = 'noindex,nofollow';
    const ref = document.createElement('meta');
    ref.name = 'referrer'; ref.content = 'no-referrer';
    document.head.append(robots, ref);
    return () => { robots.remove(); ref.remove(); };
  }, []);

  const load = useCallback(async () => {
    setView({ k: 'loading' });
    try {
      const p = await previewPass(token);
      setPreview(p);
      const codes = p.devices?.map((d) => d.code) ?? [];
      setDoor(wantedDoor && codes.includes(wantedDoor) ? wantedDoor : codes.length === 1 ? codes[0]! : null);
      setView(p.status === 'active' ? { k: 'ready' } : { k: 'blocked', reason: STATUS_TO_REASON[p.status] ?? 'pass_invalid' });
    } catch (e) {
      setView({ k: 'network', msg: e instanceof Error ? e.message : 'Sin conexión' });
    }
  }, [token, wantedDoor]);

  useEffect(() => { void load(); }, [load]);

  const pinLen = preview?.pin_length ?? 6;

  const submit = useCallback(async (value: string) => {
    if (sending.current || !door) return;
    sending.current = true;
    setView({ k: 'sending' }); setPinError(null);
    try {
      const r = await redeemPass(token, value, door);
      if (r.granted) {
        setView({ k: 'open', usesLeft: r.uses_left, unlockMs: r.unlock_ms });
        setPin('');
      } else if (r.reason === 'pin_invalid' && r.attempts_left === 0) {
        setPin(''); setView({ k: 'denied', reason: 'pass_locked' }); // el 5.º fallo ya bloquea el acceso 15 min
      } else if (r.reason === 'pin_invalid') {
        setPin(''); setShake((n) => n + 1);
        setPinError(r.attempts_left !== undefined && r.attempts_left <= 2
          ? `PIN incorrecto. Te ${r.attempts_left === 1 ? 'queda 1 intento' : `quedan ${r.attempts_left} intentos`}.`
          : 'PIN incorrecto. Inténtalo de nuevo.');
        setView({ k: 'ready' });
      } else {
        setPin(''); setView({ k: 'denied', reason: r.reason });
      }
    } catch (e) {
      setPin(''); setView({ k: 'network', msg: e instanceof Error ? e.message : 'Sin conexión' });
    } finally { sending.current = false; }
  }, [token, door]);

  const press = useCallback((d: string) => {
    if (view.k !== 'ready' || !door) return;
    navigator.vibrate?.(8);
    setPinError(null);
    setPin((cur) => {
      if (cur.length >= pinLen) return cur;
      const next = cur + d;
      if (next.length === pinLen) setTimeout(() => void submit(next), 120);
      return next;
    });
  }, [view.k, door, pinLen, submit]);

  const back = useCallback(() => { if (view.k === 'ready') { navigator.vibrate?.(6); setPin((p) => p.slice(0, -1)); } }, [view.k]);

  // Teclado físico (escritorio)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, back]);

  const doorName = useMemo(() => preview?.devices?.find((d) => d.code === door)?.name ?? null, [preview, door]);
  const blockedInfo = view.k === 'blocked' ? describe(view.reason, preview) : null;
  const deniedInfo = view.k === 'denied' ? describe(view.reason, preview) : null;

  return (
    <div className="guest">
      <div className="guest-glow" aria-hidden />
      <main className="guest-card" aria-live="polite">
        <header className="guest-head">
          <span className="guest-badge"><KeyRound size={14} aria-hidden /> Llave digital</span>
          {preview?.guest && view.k !== 'loading' && view.k !== 'network' && <h1>Hola, {preview.guest}</h1>}
        </header>

        {view.k === 'loading' && <div className="guest-center"><Spinner /><p className="muted">Verificando tu acceso…</p></div>}

        {view.k === 'network' && (
          <div className="guest-center">
            <div className="guest-icon bad"><WifiOff size={34} aria-hidden /></div>
            <h2>Sin conexión</h2>
            <p className="muted">{view.msg}</p>
            <button className="btn btn-primary" onClick={() => void load()}><RefreshCw size={16} aria-hidden />Reintentar</button>
          </div>
        )}

        {blockedInfo && (
          <div className="guest-center">
            <div className="guest-icon bad"><blockedInfo.Icon size={36} aria-hidden /></div>
            <p className="guest-denied-tag">ACCESO DENEGADO</p>
            <h2>{blockedInfo.title}</h2>
            <p className="muted">{blockedInfo.text}</p>
            {view.k === 'blocked' && view.reason === 'outside_schedule' && <button className="btn" onClick={() => void load()}><RefreshCw size={16} aria-hidden />Comprobar de nuevo</button>}
            {view.k === 'blocked' && view.reason !== 'pass_invalid' && <p className="muted small">Si crees que es un error, contacta a quien te compartió el acceso.</p>}
          </div>
        )}

        {deniedInfo && (
          <div className="guest-center">
            <div className="guest-icon bad"><deniedInfo.Icon size={36} aria-hidden /></div>
            <p className="guest-denied-tag">ACCESO DENEGADO</p>
            <h2>{deniedInfo.title}</h2>
            <p className="muted">{deniedInfo.text}</p>
            {view.k === 'denied' && RETRYABLE.has(view.reason) && <button className="btn btn-primary" onClick={() => { setView({ k: 'ready' }); }}><RefreshCw size={16} aria-hidden />Intentar de nuevo</button>}
            {view.k === 'denied' && !RETRYABLE.has(view.reason) && <p className="muted small">El intento quedó registrado.</p>}
          </div>
        )}

        {(view.k === 'ready' || view.k === 'sending') && (
          <>
            <div className="guest-meta">
              {doorName && <div className="guest-door"><DoorClosed size={16} aria-hidden /> {doorName}</div>}
              {preview?.valid_until && <div className="muted small">Válido hasta {fmtDateTime(preview.valid_until)}{preview.max_uses != null ? ` · ${usesText(preview.max_uses)}` : ''}</div>}
            </div>

            {!door && preview?.devices && preview.devices.length > 1 && (
              <div className="guest-doors">
                <p className="muted small">¿Qué puerta quieres abrir?</p>
                <div className="chips tight">
                  {preview.devices.map((d) => <button key={d.code} className="chip" onClick={() => setDoor(d.code)}>{d.name}</button>)}
                </div>
              </div>
            )}

            {door && (
              <>
                <div key={shake} className={`pin-dots ${shake ? 'shake' : ''}`} role="group" aria-label={`PIN de ${pinLen} dígitos`}>
                  {Array.from({ length: pinLen }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
                </div>
                <p className={`pin-hint ${pinError ? 'err' : ''}`} role={pinError ? 'alert' : undefined}>
                  {view.k === 'sending' ? <><Spinner /> Verificando y abriendo…</> : pinError ?? 'Escribe tu PIN para abrir'}
                </p>

                <div className="keypad" aria-label="Teclado numérico">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                    <button key={d} className="key" disabled={view.k === 'sending'} onClick={() => press(d)}>{d}</button>
                  ))}
                  <span />
                  <button className="key" disabled={view.k === 'sending'} onClick={() => press('0')}>0</button>
                  <button className="key key-icon" aria-label="Borrar" disabled={view.k === 'sending' || !pin} onClick={back}><Delete size={22} /></button>
                </div>
              </>
            )}
          </>
        )}

        {view.k === 'open' && <OpenState usesLeft={view.usesLeft} unlockMs={view.unlockMs} doorName={doorName} onAgain={() => setView({ k: 'ready' })} />}
      </main>
    </div>
  );
}

function OpenState({ usesLeft, unlockMs, doorName, onAgain }: { usesLeft: number | null; unlockMs: number; doorName: string | null; onAgain: () => void }) {
  const [closed, setClosed] = useState(false);
  useEffect(() => { const t = setTimeout(() => setClosed(true), unlockMs); return () => clearTimeout(t); }, [unlockMs]);
  return (
    <div className="guest-center">
      <div className={`guest-key-open ${closed ? 'done' : ''}`}>
        <span /><span />
        <div>{closed ? <LockKeyhole size={46} aria-hidden /> : <LockKeyholeOpen size={46} aria-hidden />}</div>
      </div>
      <h2>{closed ? 'La puerta se volvió a cerrar' : 'Puerta abierta'}</h2>
      <p className="muted">{closed ? 'Que tengas un excelente día.' : `Empuja ${doorName ? `la puerta de ${doorName}` : 'la puerta'} ahora.`}</p>
      {usesLeft === 0 && <p className="guest-note"><Check size={14} aria-hidden /> Ese era tu último uso.</p>}
      {usesLeft !== null && usesLeft > 0 && <p className="muted small">Te quedan {usesLeft} {usesLeft === 1 ? 'uso' : 'usos'}.</p>}
      {usesLeft !== 0 && <button className="btn" onClick={onAgain}>Abrir otra vez</button>}
    </div>
  );
}
