import { useEffect, useRef, useState } from 'react';
import { DoorOpen, ShieldAlert, Timer } from 'lucide-react';
import { api } from '../lib';
import type { DeviceAction, DeviceView } from '../lib/types';
import { fmtDuration, mmss, RESET_LABELS, rssiBars, timeAgo } from '../lib/format';
import { ConfirmModal, Modal, Segmented, SignalBars, SlideToUnlock, Spinner, useNow, useToast, type SlideState } from './ui';

type Phase = 'idle' | 'sending' | 'waiting' | 'open' | 'error';
type Unit = 's' | 'min' | 'h';

const HOLD_PRESETS = [30, 60, 300, 900, 1800, 3600]; // segundos
const HOLD_MIN_S = 5;
const HOLD_MAX_S = 4 * 3600;                         // igual que la Edge Function device-control
const UNIT_S: Record<Unit, number> = { s: 1, min: 60, h: 3600 };
const STALE_MS = 45_000;    // el ESP32 late cada 15 s; el servidor lo marca desconectado a los 45 s
const HEAT_WARN_S = 300;    // a partir de aquí se avisa del calentamiento del solenoide

const PENDING_LABELS: Record<DeviceAction, string> = {
  hold_open: 'Liberando la puerta…', release: 'Asegurando la puerta…',
  lockdown_on: 'Activando bloqueo total…', lockdown_off: 'Quitando bloqueo total…',
};

export function DoorCard({ device, onChanged }: { device: DeviceView; onChanged: () => Promise<void> | void }) {
  const now = useNow(1000);
  const { push } = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [phaseMsg, setPhaseMsg] = useState('');
  const [pending, setPending] = useState<DeviceAction | null>(null);   // orden de control en curso
  const [confirmLockdown, setConfirmLockdown] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(0);                         // inicio de la cuenta regresiva del solenoide
  const resetTimer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const s = device.state;
  const lastSeen = s.last_seen_at ? new Date(s.last_seen_at).getTime() : 0;
  const online = s.is_online && now - lastSeen < STALE_MS;
  const holdUntil = device.hold_open_until ? new Date(device.hold_open_until).getTime() : 0;
  const holding = holdUntil > now && !device.lockdown;
  const isOpen = holding || s.lock_state === 'unlocked' || phase === 'open';
  // Una sola orden a la vez: mientras una está en curso, todo lo demás queda bloqueado.
  const busy = phase === 'sending' || phase === 'waiting' || pending !== null;
  const bars = online ? rssiBars(s.rssi) : 0;
  const bootedAt = s.last_seen_at && s.uptime_seconds != null
    ? new Date(lastSeen - s.uptime_seconds * 1000).toISOString() : null;

  async function doUnlock() {
    if (busy || isOpen || !online) return;
    window.clearTimeout(resetTimer.current);
    setPhase('sending'); setPhaseMsg('Enviando orden…');
    try {
      const { commandId } = await api.unlock(device.device_code);
      setPhase('waiting'); setPhaseMsg('Esperando a la cerradura…');
      const st = await api.waitCommand(commandId, 9000);
      if (st === 'acked') {
        setPhase('open'); setPhaseMsg('Puerta abierta'); setOpenedAt(Date.now());
        resetTimer.current = window.setTimeout(() => setPhase('idle'), device.unlock_ms + 400);
      } else {
        setPhase('error'); setPhaseMsg(st === 'failed' ? 'La cerradura reportó un fallo' : 'La puerta no respondió');
        resetTimer.current = window.setTimeout(() => setPhase('idle'), 4000);
      }
    } catch (e) {
      setPhase('error'); setPhaseMsg(e instanceof Error ? e.message : 'Error');
      resetTimer.current = window.setTimeout(() => setPhase('idle'), 4500);
    }
  }

  async function control(action: DeviceAction, seconds?: number, okMsg?: string) {
    if (busy) return;
    setPending(action);
    try {
      const { delivered } = await api.deviceControl(device.device_code, action, seconds);
      await onChanged();   // el botón no se libera hasta tener el estado nuevo (sin parpadeos)
      if (!delivered) push({ kind: 'warn', title: okMsg ?? 'Orden guardada', text: 'La cerradura la aplicará en su próximo latido (máx. 15 s).' });
      else if (okMsg) push({ kind: action === 'lockdown_on' ? 'warn' : 'ok', title: okMsg });
    } catch (e) {
      push({ kind: 'err', title: 'No se pudo completar la acción', text: e instanceof Error ? e.message : undefined });
    } finally { setPending(null); }
  }

  const verifying = phase === 'sending' || phase === 'waiting';
  const stage: 'locked' | 'verifying' | 'unlocked' = verifying ? 'verifying' : isOpen ? 'unlocked' : 'locked';
  const slideState: SlideState = verifying ? 'verifying' : isOpen ? 'unlocked' : phase === 'error' ? 'error' : 'idle';
  // Cuenta regresiva solo cuando la apertura la lanzó esta pantalla: sabemos desde cuándo corre el solenoide.
  const countdownMs = phase === 'open' && openedAt ? Math.max(0, device.unlock_ms - (now - openedAt)) : 0;

  const label =
    pending ? PENDING_LABELS[pending]
    : verifying || phase === 'error' ? phaseMsg
    : holding ? `Liberada · ${mmss(holdUntil - now)}`
    : isOpen ? 'Desbloqueada'
    : !online ? 'Cerradura sin conexión'
    : device.lockdown ? 'Desliza · abrir como admin' : 'Desliza para abrir';

  const holdBlockedWhy = device.lockdown ? 'Quita primero el bloqueo total' : !online ? 'La cerradura está desconectada' : undefined;

  return (
    <article className={`card door ${device.lockdown ? 'is-lockdown' : ''}`} aria-label={device.name}>
      <header className="door-head">
        <div>
          <h3>{device.name}</h3>
          <p className="muted small">{device.location ?? device.device_code}</p>
        </div>
        <span className={`link-badge ${online ? 'on' : ''}`} title={online ? 'ESP32 en línea' : 'ESP32 sin conexión'}>
          <i className="link-dot" aria-hidden />
          {online
            ? <><b>En línea</b><SignalBars bars={bars} />{s.rssi != null ? `${s.rssi} dBm` : ''}<span>· {s.last_seen_at ? `${Math.max(0, Math.round((now - lastSeen) / 1000))} s` : '—'}</span></>
            : <b>Sin conexión</b>}
        </span>
      </header>

      {device.lockdown && (
        <div className="banner banner-danger" role="alert">
          <ShieldAlert size={18} aria-hidden />
          <div><strong>Bloqueo total activo.</strong> Solo administradores pueden entrar.</div>
        </div>
      )}
      {holding && (
        <div className="banner banner-warn">
          <Timer size={18} aria-hidden />
          <div><strong>Puerta liberada</strong> · se cierra en <b className="mono">{mmss(holdUntil - now)}</b></div>
          <button className="btn btn-sm" disabled={busy} onClick={() => void control('release', undefined, 'Puerta asegurada de nuevo')}>
            {pending === 'release' ? <Spinner /> : 'Cerrar ahora'}
          </button>
        </div>
      )}

      <div className={`rail ${device.lockdown ? 'is-lockdown' : ''}`} aria-hidden>
        <div className={`rail-step s-locked ${stage === 'locked' ? 'on' : ''}`}><i /><span>Bloqueado</span></div>
        <div className={`rail-step s-verifying ${stage === 'verifying' ? 'on' : ''}`}><i /><span>Verificando</span></div>
        <div className={`rail-step s-unlocked ${stage === 'unlocked' ? 'on' : ''}`}>
          <i>{stage === 'unlocked' && (phase === 'open' && openedAt
            ? <b key={openedAt} style={{ animationDuration: `${device.unlock_ms}ms` }} />
            : <b className="static" />)}</i>
          <span className="rail-t">Desbloqueado{countdownMs > 0 && <em>{(countdownMs / 1000).toFixed(1)} s</em>}</span>
        </div>
      </div>

      <SlideToUnlock state={slideState} label={label} lockdown={device.lockdown}
        disabled={!online || busy || isOpen} onComplete={() => void doUnlock()} />

      <div className="door-actions">
        <button className={`btn ${device.lockdown ? 'btn-primary' : 'btn-danger-ghost'}`} disabled={busy}
          onClick={() => (device.lockdown ? void control('lockdown_off', undefined, 'Bloqueo total desactivado') : setConfirmLockdown(true))}>
          {pending === 'lockdown_on' || pending === 'lockdown_off' ? <Spinner /> : <ShieldAlert size={16} aria-hidden />}
          {device.lockdown ? 'Quitar bloqueo' : 'Bloqueo total'}
        </button>
        <button className="btn" disabled={busy || !!holdBlockedWhy} title={holdBlockedWhy} onClick={() => setHoldOpen(true)}>
          {pending === 'hold_open' ? <Spinner /> : <DoorOpen size={16} aria-hidden />}
          {holding ? 'Cambiar tiempo' : 'Mantener abierta'}
        </button>
      </div>

      <dl className="telemetry">
        <div><dt>Cerradura</dt><dd>{s.lock_state === 'locked' ? 'Cerrada' : s.lock_state === 'unlocked' ? 'Abierta' : '—'}</dd></div>
        <div><dt>Último latido</dt><dd>{timeAgo(s.last_seen_at, now)}</dd></div>
        <div><dt>Firmware</dt><dd>{s.firmware_version ?? '—'}</dd></div>
        <div><dt>IP</dt><dd>{s.ip_address ?? '—'}</dd></div>
        <div className="wide">
          <dt>Encendida</dt>
          <dd>
            {bootedAt ? timeAgo(bootedAt, now) : '—'}
            {s.last_reset_reason && (
              <span className={s.last_reset_reason === 'brownout' ? 'bad' : 'muted'}> · {RESET_LABELS[s.last_reset_reason] ?? s.last_reset_reason}</span>
            )}
          </dd>
        </div>
      </dl>

      {confirmLockdown && (
        <ConfirmModal danger title="¿Activar bloqueo total?" confirmLabel="Activar bloqueo"
          text={`Se negará el acceso a todas las personas, tarjetas y pases en «${device.name}». Los administradores podrán seguir entrando.${holding ? ' La puerta liberada se cerrará.' : ''} Puedes quitarlo en cualquier momento.`}
          onClose={() => setConfirmLockdown(false)}
          onConfirm={() => control('lockdown_on', undefined, 'Bloqueo total activado')} />
      )}
      {holdOpen && (
        <HoldModal holding={holding} onClose={() => setHoldOpen(false)}
          onPick={(sec) => { setHoldOpen(false); void control('hold_open', sec, `Puerta liberada ${fmtDuration(sec)}`); }} />
      )}
    </article>
  );
}

function HoldModal({ holding, onClose, onPick }: { holding: boolean; onClose: () => void; onPick: (seconds: number) => void }) {
  const [amount, setAmount] = useState('10');
  const [unit, setUnit] = useState<Unit>('min');
  const n = Number(amount.replace(',', '.'));
  const seconds = Math.round(n * UNIT_S[unit]);
  const error =
    !amount.trim() || !Number.isFinite(n) || n <= 0 ? 'Escribe un número mayor que 0'
    : seconds < HOLD_MIN_S ? `Mínimo ${HOLD_MIN_S} segundos`
    : seconds > HOLD_MAX_S ? `Máximo ${fmtDuration(HOLD_MAX_S)}`
    : null;

  return (
    <Modal title={holding ? 'Cambiar tiempo abierta' : 'Mantener puerta abierta'} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" disabled={!!error} onClick={() => onPick(seconds)}>
          {error ? 'Mantener abierta' : `Mantener ${fmtDuration(seconds)}`}
        </button>
      </>}>
      <p className="muted">
        {holding ? 'El nuevo tiempo cuenta desde ahora.' : 'La cerradura quedará liberada y se asegurará sola al terminar el tiempo.'}
      </p>
      <div className="chips">
        {HOLD_PRESETS.map((sec) => (
          <button key={sec} className="chip" onClick={() => onPick(sec)}>{fmtDuration(sec)}</button>
        ))}
      </div>
      <div className="field">
        <span>Otro tiempo</span>
        <div className="hold-custom">
          <input type="text" inputMode="decimal" autoComplete="off" value={amount}
            onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !error) onPick(seconds); }}
            aria-invalid={!!error} aria-label="Duración" />
          <Segmented value={unit} onChange={setUnit}
            options={[{ value: 's', label: 'seg' }, { value: 'min', label: 'min' }, { value: 'h', label: 'horas' }]} />
        </div>
      </div>
      {error && <p className="form-error hold-note" role="alert">{error}</p>}
      {!error && seconds > HEAT_WARN_S && (
        <p className="muted small hold-note">
          El solenoide estará energizado todo ese tiempo. Si no es de servicio continuo, se calienta: prefiere tiempos cortos.
        </p>
      )}
    </Modal>
  );
}
