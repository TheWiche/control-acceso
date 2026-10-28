import { useMemo, useState } from 'react';
import { Activity, CheckCircle2, KeyRound, Link2, ShieldAlert, Smartphone, XOctagon } from 'lucide-react';
import type { AccessLog } from '../lib/types';
import { DENY_REASONS, METHOD_LABELS, fmtDuration, fmtTime, fmtUid, isUnknownCard, timeAgo } from '../lib/format';
import { Empty, Segmented, useNow } from './ui';

const methodIcon = (m: AccessLog['method']) =>
  m === 'guest_pass' ? Link2 : m === 'remote_app' || m === 'door_tag' ? Smartphone : KeyRound;

export function ActivityFeed({ logs, fresh }: { logs: AccessLog[]; fresh: Set<number> }) {
  const [filter, setFilter] = useState<'all' | 'denied'>('all');
  const now = useNow(15000);
  const shown = useMemo(() => (filter === 'denied' ? logs.filter((l) => l.result === 'denied') : logs).slice(0, 60), [logs, filter]);

  return (
    <section className="card feed" aria-label="Actividad en vivo">
      <header className="card-head">
        <h3><span className="live-dot" aria-hidden /> Actividad en vivo</h3>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Todo' }, { value: 'denied', label: 'Denegados' }]} />
      </header>

      {shown.length === 0 ? (
        <Empty icon={<Activity size={28} />} title="Sin actividad" text="Los accesos aparecerán aquí al instante." />
      ) : (
        <ul className="feed-list">
          {shown.map((l) => {
            const unknown = isUnknownCard(l);
            const denied = l.result === 'denied';
            const Icon = unknown ? ShieldAlert : denied ? XOctagon : methodIcon(l.method) === KeyRound ? CheckCircle2 : methodIcon(l.method);
            return (
              <li key={l.id} className={`feed-item ${unknown ? 'unknown' : denied ? 'denied' : 'granted'} ${fresh.has(l.id) ? 'fresh' : ''}`}>
                <span className="feed-icon" aria-hidden><Icon size={18} /></span>
                <div className="feed-main">
                  <strong>
                    {unknown ? 'Tarjeta no registrada'
                      : denied ? (DENY_REASONS[l.deny_reason ?? ''] ?? 'Acceso denegado')
                      : (l.actor_name ?? 'Acceso concedido')}
                  </strong>
                  <span className="muted small">
                    {unknown && l.credential_uid ? <><span className="mono">{fmtUid(l.credential_uid)}</span> · </> : null}
                    {denied && !unknown && l.actor_name ? `${l.actor_name} · ` : null}
                    {l.meta?.action === 'hold_open'
                      ? `Mantener abierta${l.meta.seconds ? ` ${fmtDuration(l.meta.seconds)}` : ''}`
                      : METHOD_LABELS[l.method]}
                    {l.device_name ? ` · ${l.device_name}` : ''}
                  </span>
                </div>
                <time className="feed-time" dateTime={l.occurred_at} title={fmtTime(l.occurred_at)}>
                  <span>{fmtTime(l.occurred_at).slice(0, 5)}</span>
                  <span className="muted small">{timeAgo(l.occurred_at, now)}</span>
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
