import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib';
import type { AccessLog, ActivityPoint, DeviceView, Metrics } from '../lib/types';
import { DENY_REASONS, fmtUid, isUnknownCard } from '../lib/format';
import { DoorCard } from '../components/DoorCard';
import { ActivityFeed } from '../components/ActivityFeed';
import { ActivityChart, MetricsRow } from '../components/Metrics';
import { Empty, Spinner, useToast } from '../components/ui';
import { DoorClosed } from 'lucide-react';

export function Dashboard() {
  const { push } = useToast();
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [logs, setLogs] = useState<AccessLog[]>([]);
  const [points, setPoints] = useState<ActivityPoint[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const metricsTimer = useRef<number>(0);

  const refreshDevices = useCallback(async () => {
    try { setDevices(await api.listDevices()); } catch (e) { setError(e instanceof Error ? e.message : 'Error'); }
  }, []);
  const refreshMetrics = useCallback(() => {
    window.clearTimeout(metricsTimer.current);
    metricsTimer.current = window.setTimeout(() => { api.metrics().then(setMetrics).catch(() => {}); }, 400);
  }, []);

  useEffect(() => {
    void refreshDevices();
    api.listLogs(60).then(setLogs).catch((e) => setError(e instanceof Error ? e.message : 'Error'));
    api.activitySince(24).then(setPoints).catch(() => {});
    api.metrics().then(setMetrics).catch(() => {});

    const offDev = api.subscribeDevices((patch) =>
      setDevices((cur) => cur?.map((d) => d.id !== patch.id ? d : {
        ...d, ...patch.device, state: { ...d.state, ...patch.state },
      }) ?? cur));

    const offLogs = api.subscribeLogs((log) => {
      setLogs((cur) => (cur.some((l) => l.id === log.id) ? cur : [log, ...cur].slice(0, 120)));
      setPoints((cur) => [{ occurred_at: log.occurred_at, result: log.result }, ...cur]);
      setFresh((f) => new Set(f).add(log.id));
      setTimeout(() => setFresh((f) => { const n = new Set(f); n.delete(log.id); return n; }), 6000);
      refreshMetrics();
      if (isUnknownCard(log)) {
        push({ kind: 'err', title: 'Intento con tarjeta no registrada',
          text: `${log.credential_uid ? fmtUid(log.credential_uid) + ' · ' : ''}${log.device_name ?? ''}` }, 9000);
      } else if (log.result === 'denied' && log.deny_reason === 'lockdown') {
        push({ kind: 'warn', title: DENY_REASONS.lockdown!, text: log.actor_name ?? log.device_name ?? undefined });
      }
    });

    return () => { offDev(); offLogs(); window.clearTimeout(metricsTimer.current); };
  }, [refreshDevices, refreshMetrics, push]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Panel</h1>
        <p className="muted">Estado en vivo de tus puertas</p>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      <MetricsRow metrics={metrics} />

      <div className="dash-grid">
        <div className="dash-left">
          {devices === null ? <div className="card center-pad"><Spinner /></div>
            : devices.length === 0 ? <Empty icon={<DoorClosed size={28} />} title="Aún no hay puertas" text="Registra un dispositivo en Supabase (ver docs/02-configuracion-inicial.md)." />
            : devices.map((d) => <DoorCard key={d.id} device={d} onChanged={refreshDevices} />)}
          <ActivityChart points={points} />
        </div>
        <ActivityFeed logs={logs} fresh={fresh} />
      </div>
    </div>
  );
}
