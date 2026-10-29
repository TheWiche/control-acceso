import { useEffect, useState } from 'react';
import { api } from '../lib';
import type { Credential, CredentialKind, CredentialStatus, DeviceView, PersonLite, ScheduleRule } from '../lib/types';
import { DAY_LABELS, DAY_NAMES, KIND_LABELS, STATUS_LABELS, fmtUid, fromLocalInput, toLocalInput } from '../lib/format';
import { Modal, Segmented, Spinner, useToast } from './ui';

const NEW = '__new__';
const NONE = '__none__';

export function CardEditor({ credential, devices, people, onClose, onSaved }: {
  credential: Credential; devices: DeviceView[]; people: PersonLite[]; onClose: () => void; onSaved: () => void;
}) {
  const { push } = useToast();
  const [label, setLabel] = useState(credential.label ?? '');
  const [kind, setKind] = useState<CredentialKind>(credential.kind);
  const [status, setStatus] = useState<CredentialStatus>(credential.status === 'pending' ? 'active' : credential.status);
  const [ownerId, setOwnerId] = useState<string>(credential.profile_id ?? NONE);
  const [newName, setNewName] = useState('');
  const [validFrom, setValidFrom] = useState(toLocalInput(credential.valid_from));
  const [validUntil, setValidUntil] = useState(toLocalInput(credential.valid_until));

  // horario (access_grants de la persona)
  const [doors, setDoors] = useState<Set<string>>(new Set());
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('18:00');
  const [loadingGrants, setLoadingGrants] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (ownerId === NONE || ownerId === NEW) { setDoors(new Set()); return; }
    let live = true;
    setLoadingGrants(true);
    api.getGrants(ownerId).then((gs) => {
      if (!live) return;
      setDoors(new Set(gs.map((g) => g.device_id)));
      const g = gs[0];
      if (g) {
        setDays(g.allowed_days ?? [1, 2, 3, 4, 5, 6, 7]);
        setAllDay(!g.time_start);
        if (g.time_start && g.time_end) { setStart(g.time_start); setEnd(g.time_end); }
      }
    }).catch(() => {}).finally(() => live && setLoadingGrants(false));
    return () => { live = false; };
  }, [ownerId]);

  const toggleDay = (n: number) => setDays((d) => (d.includes(n) ? d.filter((x) => x !== n) : [...d, n].sort()));
  const toggleDoor = (id: string) => setDoors((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function save() {
    if (ownerId === NEW && !newName.trim()) { push({ kind: 'warn', title: 'Escribe el nombre de la persona' }); return; }
    if (status === 'active' && ownerId === NONE) { push({ kind: 'warn', title: 'Asigna la tarjeta a una persona para activarla' }); return; }
    if (doors.size > 0 && days.length === 0) { push({ kind: 'warn', title: 'Elige al menos un día' }); return; }
    if (doors.size > 0 && !allDay && start === end) { push({ kind: 'warn', title: 'La hora de inicio y fin no pueden ser iguales' }); return; }
    setSaving(true);
    try {
      const pid = ownerId === NEW ? (await api.createPerson(newName)).id : ownerId === NONE ? null : ownerId;
      await api.updateCredential(credential.id, {
        label: label.trim() || null, kind, status: pid ? status : 'pending', profile_id: pid,
        valid_from: fromLocalInput(validFrom), valid_until: fromLocalInput(validUntil),
      });
      if (pid) {
        const rule: ScheduleRule = {
          allowed_days: days.length === 7 ? null : days,
          time_start: allDay ? null : start, time_end: allDay ? null : end,
        };
        await api.saveGrants(pid, [...doors], rule);
      }
      push({ kind: 'ok', title: 'Cambios guardados' });
      onSaved(); onClose();
    } catch (e) {
      push({ kind: 'err', title: 'No se pudo guardar', text: e instanceof Error ? e.message : undefined });
    } finally { setSaving(false); }
  }

  return (
    <Modal title="Editar tarjeta" onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? <Spinner /> : 'Guardar cambios'}</button>
      </>}>
      <div className="stack">
        <div className="captured"><div><span className="muted small">UID</span><div className="uid mono">{fmtUid(credential.uid)}</div></div></div>

        <div className="grid-2">
          <label className="field"><span>Etiqueta</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ej. Llavero azul #2" />
          </label>
          <div className="field"><span>Tipo</span>
            <Segmented value={kind} onChange={setKind} options={(Object.keys(KIND_LABELS) as CredentialKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))} />
          </div>
        </div>

        <label className="field"><span>Persona</span>
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value={NONE}>— Sin asignar —</option>
            <option value={NEW}>+ Nueva persona…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </label>
        {ownerId === NEW && (
          <label className="field"><span>Nombre completo</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" />
          </label>
        )}

        <div className="field"><span>Estado</span>
          <Segmented value={status} onChange={setStatus} options={(['active', 'suspended', 'lost'] as const).map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
        </div>

        <div className="grid-2">
          <label className="field"><span>Válida desde</span><input type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></label>
          <label className="field"><span>Válida hasta</span><input type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
        </div>

        <fieldset className="schedule" disabled={ownerId === NONE || ownerId === NEW}>
          <legend>Puertas y horario permitido</legend>
          {ownerId === NONE || ownerId === NEW ? (
            <p className="muted small">Guarda primero la asignación a una persona para definir sus puertas y horario.</p>
          ) : loadingGrants ? <Spinner /> : (
            <>
              <p className="muted small">El horario es de la <strong>persona</strong>: aplica a todas sus tarjetas en las puertas marcadas.</p>
              <div className="chips">
                {devices.map((d) => (
                  <button key={d.id} type="button" aria-pressed={doors.has(d.id)} className={`chip ${doors.has(d.id) ? 'on' : ''}`} onClick={() => toggleDoor(d.id)}>{d.name}</button>
                ))}
              </div>
              <div className="days" role="group" aria-label="Días permitidos">
                {DAY_LABELS.map((l, i) => (
                  <button key={i} type="button" aria-label={DAY_NAMES[i]} aria-pressed={days.includes(i + 1)}
                    className={`day ${days.includes(i + 1) ? 'on' : ''}`} onClick={() => toggleDay(i + 1)}>{l}</button>
                ))}
              </div>
              <label className="check"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> Todo el día</label>
              {!allDay && (
                <div className="grid-2">
                  <label className="field"><span>Desde</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
                  <label className="field"><span>Hasta</span><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
                </div>
              )}
              {!allDay && start > end && <p className="muted small">Ventana nocturna: de {start} hasta las {end} del día siguiente.</p>}
            </>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}
