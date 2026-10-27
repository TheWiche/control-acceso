import { useEffect, useRef, useState } from 'react';
import { DoorOpen, Lock, LockOpen, ShieldAlert, Timer, Wifi, WifiOff, X } from 'lucide-react';
import { api } from '../lib';
import type { DeviceAction, DeviceView } from '../lib/types';
import { mmss, rssiBars, timeAgo } from '../lib/format';
import { ConfirmModal, Modal, SignalBars, Spinner, useNow, useToast } from './ui';

type Phase = 'idle' | 'sending' | 'waiting' | 'open' | 'error';

const HOLD_OPTIONS = [5, 15, 30, 60, 120];
const STALE_MS = 120_000; // el cron marca offline a los 90 s; el cliente no espera a que llegue el evento

export function DoorCard({ device, onChanged }: { device: DeviceView; onChanged: () => void }) {
  const now = useNow(1000);
  const { push } = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [phaseMsg, setPhaseMsg] = useState('');
  const [confirmLockdown, setConfirmLockdown] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const resetTimer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const s = device.state;
  const lastSeen = s.last_seen_at ? new Date(s.last_seen_at).getTime() : 0;
  const online = s.is_online && now - lastSeen < STALE_MS;
  const holdUntil = device.hold_open_until ? new Date(device.hold_open_until).getTime() : 0;
  const holding = holdUntil > now;
  const physicallyOpen = s.lock_state === 'unlocked' || holding;
  const bars = online ? rssiBars(s.rssi) : 0;

  async function doUnlock() {
    if (phase === 'sending' || phase === 'waiting') return;
    window.clearTimeout(resetTimer.current);
    setPhase('sending'); setPhaseMsg('Enviando orden…');
    try {
      const { commandId } = await api.unlock(device.device_code);
      setPhase('waiting'); setPhaseMsg('Esperando a la cerradura…');
      const st = await api.waitCommand(commandId, 9000);
      if (st === 'acked') {
        setPhase('open'); setPhaseMsg('Puerta abierta');
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

  async function control(action: DeviceAction, minutes?: number, okMsg?: string) {
    setBusyAction(true);
    try {
      await api.deviceControl(device.device_code, action, minutes);
      if (okMsg) push({ kind: action === 'lockdown_on' ? 'warn' : 'ok', title: okMsg });
      onChanged();
    } catch (e) {
      push({ kind: 'err', title: 'No se pudo completar la acción', text: e instanceof Error ? e.message : undefined });
    } finally { setBusyAction(false); }
  }

  const busy = phase === 'sending' || phase === 'waiting';
  const label =
    phase === 'idle' ? (device.lockdown ? 'Abrir (admin)' : 'Abrir puerta')
    : phaseMsg;

  return (
    <article className={`card door ${device.lockdown ? 'is-lockdown' : ''}`} aria-label={device.name}>
      <header className="door-head">
        <div>
          <h3>{device.name}</h3>
          <p className="muted small">{device.location ?? device.device_code}</p>
        </div>
        <span className={`pill ${online ? 'pill-ok' : 'pill-off'}`}>
          {online ? <Wifi size={14} aria-hidden /> : <WifiOff size={14} aria-hidden />}
          {online ? 'En línea' : 'Desconectado'}
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
          <button className="btn btn-sm" disabled={busyAction || !online} onClick={() => void control('release', undefined, 'Puerta asegurada de nuevo')}>Cerrar ahora</button>
        </div>
      )}

      <div className="door-stage">
        <button className={`unlock-btn phase-${phase}`} disabled={!online || busy} onClick={() => void doUnlock()}
          aria-label={`Abrir ${device.name}`} aria-busy={busy}>
          <span className="ring ring-a" /><span className="ring ring-b" />
          <span className="unlock-core">
            {busy ? <Spinner />
              : phase === 'open' || physicallyOpen ? <LockOpen size={44} aria-hidden />
              : phase === 'error' ? <X size={44} aria-hidden />
              : <Lock size={44} aria-hidden />}
          </span>
        </button>
        <p className={`unlock-label ${phase === 'error' ? 'err' : ''}`} aria-live="polite">
          {!online && phase === 'idle' ? 'Cerradura sin conexión' : label}
        </p>
      </div>

      <div className="door-actions">
        <button className={`btn ${device.lockdown ? 'btn-primary' : 'btn-danger-ghost'}`} disabled={busyAction || !online}
          onClick={() => (device.lockdown ? void control('lockdown_off', undefined, 'Bloqueo total desactivado') : setConfirmLockdown(true))}>
          <ShieldAlert size={16} aria-hidden />{device.lockdown ? 'Quitar bloqueo' : 'Bloqueo total'}
        </button>
        <button className="btn" disabled={busyAction || !online || holding} onClick={() => setHoldOpen(true)}>
          <DoorOpen size={16} aria-hidden />Mantener abierta
        </button>
      </div>

      <dl className="telemetry">
        <div><dt>Cerradura</dt><dd>{s.lock_state === 'locked' ? 'Cerrada' : s.lock_state === 'unlocked' ? 'Abierta' : '—'}</dd></div>
        <div><dt>Señal</dt><dd><SignalBars bars={bars} /> {online && s.rssi != null ? `${s.rssi} dBm` : '—'}</dd></div>
        <div><dt>Último latido</dt><dd>{timeAgo(s.last_seen_at, now)}</dd></div>
        <div><dt>IP · FW</dt><dd className="mono">{s.ip_address ?? '—'} · {s.firmware_version ?? '—'}</dd></div>
      </dl>

      {confirmLockdown && (
        <ConfirmModal danger title="¿Activar bloqueo total?" confirmLabel="Activar bloqueo"
          text={`Se negará el acceso a todas las personas, tarjetas y pases en «${device.name}». Los administradores podrán seguir entrando. Puedes quitarlo en cualquier momento.`}
          onClose={() => setConfirmLockdown(false)}
          onConfirm={() => control('lockdown_on', undefined, 'Bloqueo total activado')} />
      )}
      {holdOpen && (
        <Modal title="Mantener puerta abierta" onClose={() => setHoldOpen(false)}>
          <p className="muted">La cerradura quedará liberada y se asegurará sola al terminar el tiempo.</p>
          <div className="chips">
            {HOLD_OPTIONS.map((m) => (
              <button key={m} className="chip" onClick={() => { setHoldOpen(false); void control('hold_open', m, `Puerta liberada ${m} min`); }}>
                {m >= 60 ? `${m / 60} h` : `${m} min`}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </article>
  );
}
