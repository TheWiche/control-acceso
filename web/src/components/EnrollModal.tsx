import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Nfc, RotateCcw, TriangleAlert } from 'lucide-react';
import { api } from '../lib';
import type { CredentialKind, DeviceView, EnrollmentSession, PersonLite } from '../lib/types';
import { KIND_LABELS, fmtUid, mmss } from '../lib/format';
import { Modal, Segmented, Spinner, Switch, useNow, useToast } from './ui';

type Step = 'setup' | 'starting' | 'listening' | 'captured' | 'problem';
const NEW = '__new__';

export function EnrollModal({ devices, people, onClose, onSaved }: {
  devices: DeviceView[]; people: PersonLite[]; onClose: () => void; onSaved: () => void;
}) {
  const { push } = useToast();
  const now = useNow(250);
  const online = useMemo(() => devices.filter((d) => d.state.is_online && d.is_active), [devices]);

  const [step, setStep] = useState<Step>('setup');
  const [deviceCode, setDeviceCode] = useState(online[0]?.device_code ?? devices[0]?.device_code ?? '');
  const [kind, setKind] = useState<CredentialKind>('nfc_keyfob');
  const [session, setSession] = useState<EnrollmentSession | null>(null);
  const [problem, setProblem] = useState('');

  // formulario de asignación
  const [ownerId, setOwnerId] = useState<string>(NEW);
  const [newName, setNewName] = useState('');
  const [label, setLabel] = useState('');
  const [grantDoor, setGrantDoor] = useState(true);
  const [saving, setSaving] = useState(false);

  // Si el modal se abrió antes de cargar las puertas (o la elegida desapareció), elige la primera en línea.
  useEffect(() => {
    if (!devices.some((d) => d.device_code === deviceCode)) setDeviceCode(online[0]?.device_code ?? devices[0]?.device_code ?? '');
  }, [devices, online, deviceCode]);

  const device = devices.find((d) => d.device_code === deviceCode);
  const offRef = useRef<() => void>(() => {});
  const sessionRef = useRef<EnrollmentSession | null>(null);
  sessionRef.current = session;
  const stepRef = useRef<Step>(step);
  stepRef.current = step;

  // Al desmontar: si seguimos escuchando, apaga el modo enrolamiento del lector.
  useEffect(() => () => {
    offRef.current();
    const s = sessionRef.current;
    if (s && stepRef.current === 'listening') void api.enrollCancel(s.id).catch(() => {});
  }, []);

  async function start() {
    setStep('starting'); setProblem('');
    try {
      const s = await api.enrollStart(deviceCode, kind);
      setSession(s); setStep('listening');
      offRef.current();
      offRef.current = api.subscribeEnrollment(s.id, (u) => {
        setSession((prev) => ({ ...(prev ?? u), ...u }));
        if (u.status === 'captured' || u.status === 'assigned') { setStep('captured'); offRef.current(); }
        if (u.status === 'failed') {
          setProblem(u.error === 'uid_already_registered'
            ? 'Esta tarjeta ya está registrada en el sistema. Búscala en la lista por su UID.'
            : 'El lector no pudo registrar la tarjeta. Inténtalo de nuevo.');
          setStep('problem'); offRef.current();
        }
        if (u.status === 'expired') { setProblem('Se acabó el tiempo sin detectar ninguna tarjeta.'); setStep('problem'); offRef.current(); }
      });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'No se pudo iniciar el modo registro.');
      setStep('problem');
    }
  }

  async function cancel() {
    offRef.current();
    if (session && step === 'listening') await api.enrollCancel(session.id).catch(() => {});
    onClose();
  }

  // Cuenta regresiva local; el servidor también expira la sesión.
  const msLeft = session ? new Date(session.expires_at).getTime() - now : 0;
  useEffect(() => {
    if (step === 'listening' && session && msLeft <= -1500) {
      setProblem('Se acabó el tiempo sin detectar ninguna tarjeta.'); setStep('problem');
      offRef.current(); void api.enrollCancel(session.id).catch(() => {});
    }
  }, [step, session, msLeft]);

  async function save() {
    if (!session?.credential_id) return;
    if (ownerId === NEW && !newName.trim()) { push({ kind: 'warn', title: 'Escribe el nombre de la persona' }); return; }
    setSaving(true);
    try {
      const pid = ownerId === NEW ? (await api.createPerson(newName)).id : ownerId;
      await api.updateCredential(session.credential_id, { profile_id: pid, status: 'active', label: label.trim() || null, kind });
      if (grantDoor && device) await api.grantDoor(pid, device.id);
      push({ kind: 'ok', title: 'Tarjeta guardada', text: `${ownerId === NEW ? newName.trim() : people.find((p) => p.id === pid)?.full_name} ya puede usarla.` });
      onSaved(); onClose();
    } catch (e) {
      push({ kind: 'err', title: 'No se pudo guardar', text: e instanceof Error ? e.message : undefined });
    } finally { setSaving(false); }
  }

  const uid = session?.captured_uid;

  return (
    <Modal title="Registrar tarjeta o llavero" onClose={() => void cancel()} dismissable={step !== 'starting'}
      footer={
        step === 'setup' ? <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={!device?.state.is_online} onClick={() => void start()}>
            <Nfc size={16} aria-hidden />Iniciar registro
          </button>
        </> : step === 'listening' ? <button className="btn" onClick={() => void cancel()}>Cancelar</button>
        : step === 'captured' ? <>
          <button className="btn" onClick={() => { onSaved(); onClose(); }}>Guardar después</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? <Spinner /> : 'Guardar y activar'}</button>
        </> : step === 'problem' ? <>
          <button className="btn" onClick={onClose}>Cerrar</button>
          <button className="btn btn-primary" onClick={() => setStep('setup')}><RotateCcw size={16} aria-hidden />Reintentar</button>
        </> : undefined
      }>
      {step === 'setup' && (
        <div className="stack">
          <p className="muted">El lector de la puerta se pondrá a la escucha durante 60 s. Mientras tanto <strong>no abrirá</strong> la puerta.</p>
          {devices.length > 1 && (
            <label className="field"><span>Lector / puerta</span>
              <select value={deviceCode} onChange={(e) => setDeviceCode(e.target.value)}>
                {devices.map((d) => <option key={d.id} value={d.device_code}>{d.name}{d.state.is_online ? '' : ' (desconectado)'}</option>)}
              </select>
            </label>
          )}
          <div className="field"><span>Tipo de credencial</span>
            <Segmented value={kind} onChange={setKind} options={[
              { value: 'nfc_keyfob', label: 'Llavero azul' }, { value: 'rfid_card', label: 'Tarjeta blanca' }, { value: 'other', label: 'Otro' }]} />
          </div>
          {!device?.state.is_online && <div className="banner banner-warn"><TriangleAlert size={18} aria-hidden /><div>El lector de «{device?.name}» está desconectado.</div></div>}
        </div>
      )}

      {(step === 'starting' || step === 'listening') && (
        <div className="listen">
          <div className="radar" aria-hidden><div className="radar-sweep" /><i /><i /><i /><div className="radar-core"><Nfc size={34} /></div></div>
          <h3>{step === 'starting' ? 'Activando lector…' : 'Acerca el llavero o la tarjeta al lector'}</h3>
          <p className="muted">Apóyalo sobre el PN532 de <strong>{device?.name}</strong>. Aparecerá aquí automáticamente.</p>
          {step === 'listening' && <div className="countdown mono" aria-live="off">{mmss(Math.max(0, msLeft))}</div>}
        </div>
      )}

      {step === 'captured' && (
        <div className="stack">
          <div className="hit" aria-hidden><span><CheckCircle2 size={30} /></span></div>
          <div className="captured">
            <Nfc size={20} aria-hidden />
            <div><span className="muted small">Tarjeta detectada</span><div className="uid mono">{uid ? fmtUid(uid) : '—'}</div></div>
          </div>

          <label className="field"><span>Persona</span>
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value={NEW}>➕ Nueva persona…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </label>
          {ownerId === NEW && (
            <label className="field"><span>Nombre completo</span>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ej. María López" autoComplete="off" />
            </label>
          )}
          <label className="field"><span>Etiqueta (opcional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`Ej. ${KIND_LABELS[kind]} #1`} />
          </label>
          <div className="row between">
            <div><strong>Dar acceso a «{device?.name}»</strong><div className="muted small">24 h · puedes ajustar el horario después</div></div>
            <Switch checked={grantDoor} onChange={setGrantDoor} label="Dar acceso a esta puerta" />
          </div>
        </div>
      )}

      {step === 'problem' && (
        <div className="listen">
          <div className="problem-icon"><TriangleAlert size={34} aria-hidden /></div>
          <h3>No se completó el registro</h3>
          <p className="muted">{problem}</p>
        </div>
      )}
    </Modal>
  );
}
