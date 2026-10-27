import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Clock, DoorOpen, Plus, RotateCw, Ticket } from 'lucide-react';
import { api } from '../lib';
import type { DeviceView, GuestPass, NewPassInput, PassSecret, PassState } from '../lib/types';
import { passState } from '../lib/types';
import { fmtDateTime, scheduleSummary, timeAgo } from '../lib/format';
import { usesText, type ShareInfo } from '../lib/share';
import { PassForm } from '../components/PassForm';
import { PassShare } from '../components/PassShare';
import { ConfirmModal, Empty, Segmented, Spinner, useNow, useToast } from '../components/ui';

const STATE_LABEL: Record<PassState, string> = {
  active: 'Vigente', scheduled: 'Programado', expired: 'Expirado', exhausted: 'Sin usos', revoked: 'Revocado',
};

interface Shared { secret: PassSecret; info: ShareInfo; doors: { code: string; name: string }[] }

export function Guests() {
  const { push } = useToast();
  const now = useNow(30_000);
  const [passes, setPasses] = useState<GuestPass[] | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [filter, setFilter] = useState<'live' | 'all'>('live');
  const [creating, setCreating] = useState(false);
  const [shared, setShared] = useState<Shared | null>(null);
  const [revoking, setRevoking] = useState<GuestPass | null>(null);
  const [rotating, setRotating] = useState<GuestPass | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setPasses(await api.listPasses()); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); }
  }, []);

  useEffect(() => {
    void load();
    api.listDevices().then(setDevices).catch(() => {});
    return api.subscribePasses(() => { void load(); });
  }, [load]);

  const doorsOf = useCallback((p: GuestPass) =>
    p.device_ids.map((id) => devices.find((d) => d.id === id)).filter((d): d is DeviceView => !!d), [devices]);

  const shown = useMemo(() => (passes ?? []).filter((p) => {
    if (filter === 'all') return true;
    const s = passState(p, now);
    return s === 'active' || s === 'scheduled';
  }), [passes, filter, now]);

  const liveCount = useMemo(() => (passes ?? []).filter((p) => ['active', 'scheduled'].includes(passState(p, now))).length, [passes, now]);

  const infoFromPass = (p: GuestPass): ShareInfo => ({
    guest: p.label, phone: p.guest_phone, doors: doorsOf(p).map((d) => d.name), from: p.valid_from, until: p.valid_until,
    days: p.allowed_days, start: p.time_start, end: p.time_end, maxUses: p.max_uses,
  });

  function onCreated(secret: PassSecret, input: NewPassInput) {
    const ds = devices.filter((d) => input.device_codes.includes(d.device_code));
    setCreating(false);
    setShared({
      secret, doors: ds.map((d) => ({ code: d.device_code, name: d.name })),
      info: { guest: input.label, phone: input.guest_phone || null, doors: ds.map((d) => d.name), from: input.valid_from, until: input.valid_until,
        days: input.allowed_days, start: input.time_start, end: input.time_end, maxUses: input.max_uses },
    });
    void load();
  }

  async function revoke(p: GuestPass) {
    const prev = passes;
    setPasses((cur) => cur?.map((x) => (x.id === p.id ? { ...x, status: 'revoked' } : x)) ?? cur);
    try {
      await api.revokePass(p.id);
      push({ kind: 'warn', title: 'Acceso revocado', text: `${p.label} ya no puede abrir.` });
    } catch (e) {
      setPasses(prev);
      push({ kind: 'err', title: 'No se pudo revocar', text: e instanceof Error ? e.message : undefined });
    }
  }

  async function rotate(p: GuestPass) {
    try {
      const secret = await api.rotatePass(p.id);
      setShared({ secret, info: infoFromPass(p), doors: doorsOf(p).map((d) => ({ code: d.device_code, name: d.name })) });
      void load();
    } catch (e) {
      push({ kind: 'err', title: 'No se pudo regenerar', text: e instanceof Error ? e.message : undefined });
    }
  }

  return (
    <div className="page">
      <header className="page-head row between wrap">
        <div>
          <h1>Invitados</h1>
          <p className="muted">Accesos temporales con enlace y PIN, sin cuenta</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={18} aria-hidden />Nuevo acceso</button>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}

      <Segmented value={filter} onChange={setFilter} options={[{ value: 'live', label: `Vigentes · ${liveCount}` }, { value: 'all', label: 'Todos' }]} />

      {passes === null ? <div className="card center-pad"><Spinner /></div>
        : shown.length === 0 ? (
          <Empty icon={<Ticket size={28} />} title={passes.length ? 'No hay accesos vigentes' : 'Aún no hay accesos de invitado'}
            text="Crea uno y compártelo por WhatsApp en segundos."
            action={<button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />Nuevo acceso</button>} />
        ) : (
          <ul className="cards-list passes">
            {shown.map((p) => {
              const st = passState(p, now);
              const live = st === 'active' || st === 'scheduled';
              return (
                <li key={p.id} className={`card pass st-${st}`}>
                  <div className="pass-top">
                    <div className="cred-main">
                      <div className="cred-title">
                        <strong>{p.label}</strong>
                        <span className={`badge pstate-${st}`}>{STATE_LABEL[st]}</span>
                      </div>
                      <div className="muted small"><DoorOpen size={13} aria-hidden /> {doorsOf(p).map((d) => d.name).join(', ') || '—'}</div>
                    </div>
                    <div className="uses" title="Usos">
                      <strong>{p.uses_count}</strong><span className="muted small">/ {p.max_uses ?? '∞'}</span>
                    </div>
                  </div>
                  <div className="pass-meta muted small">
                    <span><Clock size={13} aria-hidden /> {fmtDateTime(p.valid_from)} → {fmtDateTime(p.valid_until)}</span>
                    {(p.allowed_days || p.time_start) && <span>{scheduleSummary(p.allowed_days, p.time_start, p.time_end)}</span>}
                    <span>{usesText(p.max_uses)} · último uso: {timeAgo(p.last_used_at, now)}</span>
                  </div>
                  <div className="pass-actions">
                    <button className="btn btn-sm" onClick={() => setRotating(p)} disabled={p.status === 'revoked'}><RotateCw size={14} aria-hidden />Regenerar / reenviar</button>
                    {live && <button className="btn btn-sm btn-danger-ghost" onClick={() => setRevoking(p)}><Ban size={14} aria-hidden />Revocar</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

      {creating && <PassForm devices={devices} onClose={() => setCreating(false)} onCreated={onCreated} />}
      {shared && <PassShare secret={shared.secret} info={shared.info} doorCodes={shared.doors} onClose={() => setShared(null)} />}
      {revoking && (
        <ConfirmModal danger title="¿Revocar este acceso?" confirmLabel="Revocar ahora"
          text={`${revoking.label} dejará de poder abrir de inmediato, aunque el enlace siga en su teléfono. Esta acción no se puede deshacer (puedes crear otro acceso).`}
          onClose={() => setRevoking(null)} onConfirm={() => revoke(revoking)} />
      )}
      {rotating && (
        <ConfirmModal title="¿Regenerar enlace y PIN?" confirmLabel="Regenerar"
          text={`El enlace y el PIN actuales de ${rotating.label} dejarán de funcionar. Se creará uno nuevo para que lo reenvíes (mismas fechas, horario y límite de usos).`}
          onClose={() => setRotating(null)} onConfirm={() => rotate(rotating)} />
      )}
    </div>
  );
}
