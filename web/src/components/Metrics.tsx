import { useMemo } from 'react';
import { CheckCircle2, Link2, ShieldAlert, Users } from 'lucide-react';
import type { ActivityPoint, Metrics as M } from '../lib/types';

const tiles = [
  { key: 'grantedToday', label: 'Accesos hoy', icon: CheckCircle2, tone: 'ok' },
  { key: 'deniedToday', label: 'Denegados', icon: ShieldAlert, tone: 'bad' },
  { key: 'activePeople', label: 'Personas', icon: Users, tone: 'info' },
  { key: 'activePasses', label: 'Pases activos', icon: Link2, tone: 'accent' },
] as const;

export function MetricsRow({ metrics }: { metrics: M | null }) {
  return (
    <div className="metrics">
      {tiles.map(({ key, label, icon: Icon, tone }) => (
        <div key={key} className={`card metric tone-${tone}`}>
          <div className="metric-label"><Icon size={14} aria-hidden />{label}</div>
          <div className="metric-value">{metrics ? metrics[key] : <span className="skeleton" />}</div>
        </div>
      ))}
    </div>
  );
}

/** Barras apiladas por hora (últimas 24 h): concedidos vs denegados. SVG sin dependencias. */
export function ActivityChart({ points }: { points: ActivityPoint[] }) {
  const buckets = useMemo(() => {
    const end = new Date(); end.setMinutes(0, 0, 0);
    const arr = Array.from({ length: 24 }, (_, i) => {
      const t = new Date(end.getTime() - (23 - i) * 3600_000);
      return { t, granted: 0, denied: 0 };
    });
    const start = arr[0]!.t.getTime();
    for (const p of points) {
      const idx = Math.floor((new Date(p.occurred_at).getTime() - start) / 3600_000);
      if (idx >= 0 && idx < 24) arr[idx]![p.result]++;
    }
    return arr;
  }, [points]);

  const max = Math.max(4, ...buckets.map((b) => b.granted + b.denied));
  const W = 24 * 20, H = 120;
  const total = buckets.reduce((a, b) => a + b.granted + b.denied, 0);

  return (
    <section className="card chart" aria-label="Actividad de las últimas 24 horas">
      <header className="card-head">
        <h3>Últimas 24 horas</h3>
        <div className="legend small muted"><i className="dot dot-ok" /> Concedidos <i className="dot dot-bad" /> Denegados</div>
      </header>
      <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`${total} eventos en 24 horas`} preserveAspectRatio="none" className="chart-svg">
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="grid" />)}
        {buckets.map((b, i) => {
          const hg = (b.granted / max) * H, hd = (b.denied / max) * H;
          return (
            <g key={i}>
              <title>{`${b.t.getHours()}:00 — ${b.granted} concedidos, ${b.denied} denegados`}</title>
              <rect x={i * 20 + 3} y={H - hg} width="14" height={hg} rx="3" className="bar-ok" />
              <rect x={i * 20 + 3} y={H - hg - hd} width="14" height={hd} rx="3" className="bar-bad" />
              {i % 4 === 0 && <text x={i * 20 + 10} y={H + 14} className="axis" textAnchor="middle">{String(b.t.getHours()).padStart(2, '0')}h</text>}
            </g>
          );
        })}
      </svg>
    </section>
  );
}
