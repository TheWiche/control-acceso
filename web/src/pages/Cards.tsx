import { useCallback, useEffect, useMemo, useState } from 'react';
import { CreditCard, KeyRound, Nfc, Pencil, Search, Trash2, UserPlus } from 'lucide-react';
import { api } from '../lib';
import type { Credential, CredentialStatus, DeviceView, PersonLite } from '../lib/types';
import { KIND_LABELS, STATUS_LABELS, fmtUid, timeAgo } from '../lib/format';
import { CardEditor } from '../components/CardEditor';
import { EnrollModal } from '../components/EnrollModal';
import { ConfirmModal, Empty, Spinner, Switch, useToast } from '../components/ui';

type Filter = 'all' | 'active' | 'pending' | 'off';

function Glyph({ kind }: { kind: Credential['kind'] }) {
  return kind === 'nfc_keyfob'
    ? <span className="glyph glyph-fob" aria-hidden><KeyRound size={20} /></span>
    : <span className="glyph glyph-card" aria-hidden><CreditCard size={20} /></span>;
}

export function Cards() {
  const { push } = useToast();
  const [items, setItems] = useState<Credential[] | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [people, setPeople] = useState<PersonLite[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<Credential | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [deleting, setDeleting] = useState<Credential | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([api.listCredentials(), api.listPeople()]);
      setItems(c); setPeople(p);
    } catch (e) { setError(e instanceof Error ? e.message : 'Error'); }
  }, []);

  useEffect(() => {
    void load();
    api.listDevices().then(setDevices).catch(() => {});
    const off = api.subscribeCredentials(() => { void load(); });
    const offDev = api.subscribeDevices((patch) =>
      setDevices((cur) => cur.map((d) => d.id !== patch.id ? d : { ...d, ...patch.device, state: { ...d.state, ...patch.state } })));
    return () => { off(); offDev(); };
  }, [load]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).filter((c) => {
      if (filter === 'active' && c.status !== 'active') return false;
      if (filter === 'pending' && c.status !== 'pending') return false;
      if (filter === 'off' && !['suspended', 'lost', 'revoked'].includes(c.status)) return false;
      if (!t) return true;
      return [c.uid, c.label, c.owner?.full_name].some((v) => v?.toLowerCase().includes(t));
    });
  }, [items, q, filter]);

  const counts = useMemo(() => ({
    all: items?.length ?? 0,
    active: items?.filter((c) => c.status === 'active').length ?? 0,
    pending: items?.filter((c) => c.status === 'pending').length ?? 0,
    off: items?.filter((c) => ['suspended', 'lost', 'revoked'].includes(c.status)).length ?? 0,
  }), [items]);

  // Activar / desactivar al instante (optimista; revierte si falla)
  async function toggle(c: Credential, on: boolean) {
    const next: CredentialStatus = on ? 'active' : 'suspended';
    const prev = items;
    setItems((cur) => cur?.map((x) => (x.id === c.id ? { ...x, status: next } : x)) ?? cur);
    try {
      await api.updateCredential(c.id, { status: next });
      push({ kind: on ? 'ok' : 'warn', title: on ? 'Tarjeta activada' : 'Acceso revocado al instante', text: c.label ?? fmtUid(c.uid) });
    } catch (e) {
      setItems(prev);
      push({ kind: 'err', title: 'No se pudo cambiar el estado', text: e instanceof Error ? e.message : undefined });
    }
  }

  return (
    <div className="page">
      <header className="page-head row between wrap">
        <div>
          <h1>Tarjetas</h1>
          <p className="muted">Tarjetas blancas y llaveros azules registrados</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEnrolling(true)}><Nfc size={18} aria-hidden />Registrar nueva</button>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="toolbar">
        <label className="search">
          <Search size={18} aria-hidden />
          <input type="search" placeholder="Buscar por nombre, etiqueta o UID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar tarjetas" />
        </label>
        <div className="segmented scroll-x" role="tablist">
          {([['all', 'Todas'], ['active', 'Activas'], ['pending', 'Sin asignar'], ['off', 'Inactivas']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {l} <span className="count">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {items === null ? <div className="card center-pad"><Spinner /></div>
        : shown.length === 0 ? (
          <Empty icon={<CreditCard size={28} />} title={items.length ? 'Sin resultados' : 'Aún no hay tarjetas'}
            text={items.length ? 'Prueba con otra búsqueda o filtro.' : 'Pulsa «Registrar nueva» y acerca un llavero al lector.'}
            action={!items.length ? <button className="btn btn-primary" onClick={() => setEnrolling(true)}><Nfc size={16} aria-hidden />Registrar nueva</button> : undefined} />
        ) : (
          <ul className="cards-list">
            {shown.map((c) => {
              const expired = c.valid_until && new Date(c.valid_until) < new Date();
              return (
                <li key={c.id} className={`card cred st-${c.status}`}>
                  <Glyph kind={c.kind} />
                  <div className="cred-main">
                    <div className="cred-title">
                      <strong>{c.label ?? KIND_LABELS[c.kind]}</strong>
                      <span className={`badge badge-${c.status}`}>{STATUS_LABELS[c.status]}</span>
                      {expired && <span className="badge badge-lost">Vencida</span>}
                    </div>
                    <div className="muted small">
                      {c.owner ? c.owner.full_name : <em>Sin persona asignada</em>} · <span className="mono">{fmtUid(c.uid)}</span>
                    </div>
                    <div className="muted small">Último uso: {timeAgo(c.last_used_at)}</div>
                  </div>
                  <div className="cred-actions">
                    {c.status === 'pending' ? (
                      <button className="btn btn-primary btn-sm" onClick={() => setEditing(c)}><UserPlus size={15} aria-hidden />Asignar</button>
                    ) : (
                      <Switch checked={c.status === 'active'} disabled={c.status === 'lost' || c.status === 'revoked'}
                        label={c.status === 'active' ? 'Desactivar tarjeta' : 'Activar tarjeta'} onChange={(v) => void toggle(c, v)} />
                    )}
                    <button className="icon-btn" aria-label="Editar tarjeta y horario" onClick={() => setEditing(c)}><Pencil size={18} /></button>
                    <button className="icon-btn danger" aria-label="Eliminar tarjeta" onClick={() => setDeleting(c)}><Trash2 size={18} /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

      {enrolling && <EnrollModal devices={devices} people={people} onClose={() => setEnrolling(false)} onSaved={() => void load()} />}
      {editing && <CardEditor credential={editing} devices={devices} people={people} onClose={() => setEditing(null)} onSaved={() => void load()} />}
      {deleting && (
        <ConfirmModal danger title="¿Eliminar esta tarjeta?" confirmLabel="Eliminar"
          text={`Se borrará ${deleting.label ?? fmtUid(deleting.uid)} del sistema. Los registros de acceso anteriores se conservan. Si solo quieres bloquearla, usa el interruptor.`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try { await api.deleteCredential(deleting.id); push({ kind: 'ok', title: 'Tarjeta eliminada' }); await load(); }
            catch (e) { push({ kind: 'err', title: 'No se pudo eliminar', text: e instanceof Error ? e.message : undefined }); }
          }} />
      )}
    </div>
  );
}
