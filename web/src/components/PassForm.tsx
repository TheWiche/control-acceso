import { useState } from 'react';
import { api } from '../lib';
import type { DeviceView, NewPassInput, PassSecret } from '../lib/types';
import { DAY_LABELS, DAY_NAMES, fromLocalInput, toLocalInput } from '../lib/format';
import { Modal, Segmented, Spinner, useToast } from './ui';

type PinMode = 'auto' | 'custom';
type UsesMode = 'unlimited' | 'once' | 'n';

const PRESETS: { label: string; hours: number }[] = [
  { label: '1 hora', hours: 1 }, { label: '24 horas', hours: 24 }, { label: '3 días', hours: 72 },
  { label: '7 días', hours: 168 }, { label: '30 días', hours: 720 },
];

const nowLocal = () => { const d = new Date(); d.setSeconds(0, 0); return d.toISOString(); };
const plusHours = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3600_000).toISOString();

export function PassForm({ devices, onClose, onCreated }: {
  devices: DeviceView[]; onClose: () => void; onCreated: (secret: PassSecret, input: NewPassInput) => void;
}) {
  const { push } = useToast();
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [doors, setDoors] = useState<string[]>(devices.length === 1 ? [devices[0]!.device_code] : []);
  const start0 = nowLocal();
  const [from, setFrom] = useState(toLocalInput(start0));
  const [until, setUntil] = useState(toLocalInput(plusHours(start0, 24)));
  const [preset, setPreset] = useState<number | null>(24);
  const [usesMode, setUsesMode] = useState<UsesMode>('unlimited');
  const [usesN, setUsesN] = useState('5');
  const [limitSchedule, setLimitSchedule] = useState(false);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [tStart, setTStart] = useState('08:00');
  const [tEnd, setTEnd] = useState('18:00');
  const [useWindow, setUseWindow] = useState(false);
  const [pinMode, setPinMode] = useState<PinMode>('auto');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const toggleDoor = (c: string) => setDoors((d) => (d.includes(c) ? d.filter((x) => x !== c) : [...d, c]));
  const toggleDay = (n: number) => setDays((d) => (d.includes(n) ? d.filter((x) => x !== n) : [...d, n].sort()));

  function applyPreset(hours: number) {
    setPreset(hours);
    const s = nowLocal();
    setFrom(toLocalInput(s)); setUntil(toLocalInput(plusHours(s, hours)));
  }

  function validate(): string | null {
    if (!label.trim()) return 'Escribe el nombre del invitado';
    if (!doors.length) return 'Elige al menos una puerta';
    const f = fromLocalInput(from), u = fromLocalInput(until);
    if (!f || !u) return 'Indica inicio y fin';
    if (new Date(u) <= new Date(f)) return 'El fin debe ser posterior al inicio';
    if (new Date(u) < new Date()) return 'El fin ya pasó';
    if (limitSchedule && !days.length) return 'Elige al menos un día';
    if (limitSchedule && useWindow && tStart === tEnd) return 'La hora de inicio y fin no pueden ser iguales';
    if (usesMode === 'n' && !(Number(usesN) >= 1 && Number.isInteger(Number(usesN)))) return 'El límite de usos debe ser un entero ≥ 1';
    if (pinMode === 'custom') {
      if (!/^\d{4,8}$/.test(pin)) return 'El PIN debe tener entre 4 y 8 dígitos';
      if (/^(\d)\1+$/.test(pin)) return 'El PIN es demasiado simple (todos los dígitos iguales)';
    }
    return null;
  }

  async function submit() {
    const err = validate();
    if (err) { push({ kind: 'warn', title: err }); return; }
    const input: NewPassInput = {
      label: label.trim(), guest_phone: phone.trim(),
      valid_from: fromLocalInput(from)!, valid_until: fromLocalInput(until)!,
      device_codes: doors,
      allowed_days: limitSchedule && days.length < 7 ? days : null,
      time_start: limitSchedule && useWindow ? tStart : null, time_end: limitSchedule && useWindow ? tEnd : null,
      max_uses: usesMode === 'unlimited' ? null : usesMode === 'once' ? 1 : Number(usesN),
      pin: pinMode === 'custom' ? pin : undefined,
    };
    setBusy(true);
    try {
      const secret = await api.createPass(input);
      onCreated(secret, input);
    } catch (e) {
      push({ kind: 'err', title: 'No se pudo crear el acceso', text: e instanceof Error ? e.message : undefined });
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Nuevo acceso de invitado" onClose={onClose} wide dismissable={!busy}
      footer={<>
        <button className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? <Spinner /> : 'Crear acceso'}</button>
      </>}>
      <div className="stack">
        <div className="grid-2">
          <label className="field"><span>Nombre del invitado</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ej. Pedro (plomero)" maxLength={80} autoComplete="off" />
          </label>
          <label className="field"><span>WhatsApp (opcional)</span>
            <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+57 300 123 4567" autoComplete="off" />
          </label>
        </div>

        <div className="field"><span>Puertas</span>
          <div className="chips tight">
            {devices.map((d) => (
              <button key={d.id} type="button" aria-pressed={doors.includes(d.device_code)} className={`chip ${doors.includes(d.device_code) ? 'on' : ''}`} onClick={() => toggleDoor(d.device_code)}>{d.name}</button>
            ))}
          </div>
        </div>

        <fieldset className="schedule">
          <legend>Vigencia</legend>
          <div className="chips tight">
            {PRESETS.map((p) => (
              <button key={p.hours} type="button" className={`chip ${preset === p.hours ? 'on' : ''}`} onClick={() => applyPreset(p.hours)}>{p.label}</button>
            ))}
          </div>
          <div className="grid-2">
            <label className="field"><span>Inicio</span><input type="datetime-local" value={from} onChange={(e) => { setFrom(e.target.value); setPreset(null); }} /></label>
            <label className="field"><span>Fin</span><input type="datetime-local" value={until} onChange={(e) => { setUntil(e.target.value); setPreset(null); }} /></label>
          </div>
        </fieldset>

        <div className="field"><span>Límite de usos</span>
          <Segmented<UsesMode> value={usesMode} onChange={setUsesMode} options={[
            { value: 'unlimited', label: 'Ilimitado' }, { value: 'once', label: '1 solo uso' }, { value: 'n', label: 'Otro…' }]} />
          {usesMode === 'n' && <input type="number" inputMode="numeric" min={1} max={1000} value={usesN} onChange={(e) => setUsesN(e.target.value)} aria-label="Número de usos" />}
          <span className="muted small">«Ilimitado» permite abrir las veces que quiera hasta que venza.</span>
        </div>

        <label className="check">
          <input type="checkbox" checked={limitSchedule} onChange={(e) => setLimitSchedule(e.target.checked)} />
          <span>Limitar por días de la semana y horario</span>
        </label>
        {limitSchedule && (
          <div className="schedule">
            <div className="days" role="group" aria-label="Días permitidos">
              {DAY_LABELS.map((l, i) => (
                <button key={i} type="button" aria-label={DAY_NAMES[i]} aria-pressed={days.includes(i + 1)} className={`day ${days.includes(i + 1) ? 'on' : ''}`} onClick={() => toggleDay(i + 1)}>{l}</button>
              ))}
            </div>
            <label className="check"><input type="checkbox" checked={useWindow} onChange={(e) => setUseWindow(e.target.checked)} /> Solo en un horario</label>
            {useWindow && (
              <div className="grid-2">
                <label className="field"><span>Desde</span><input type="time" value={tStart} onChange={(e) => setTStart(e.target.value)} /></label>
                <label className="field"><span>Hasta</span><input type="time" value={tEnd} onChange={(e) => setTEnd(e.target.value)} /></label>
              </div>
            )}
            <p className="muted small">Horas según la zona horaria configurada para la puerta.</p>
          </div>
        )}

        <div className="field"><span>PIN</span>
          <Segmented<PinMode> value={pinMode} onChange={setPinMode} options={[{ value: 'auto', label: 'Generar automático' }, { value: 'custom', label: 'Elegir uno' }]} />
          {pinMode === 'custom' && (
            <input inputMode="numeric" pattern="[0-9]*" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="4 a 8 dígitos" aria-label="PIN personalizado" autoComplete="off" />
          )}
        </div>
      </div>
    </Modal>
  );
}
