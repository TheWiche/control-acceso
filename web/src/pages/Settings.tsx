import { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe, Save, Settings as SettingsIcon } from 'lucide-react';
import { api } from '../lib';
import type { DeviceSettings, DeviceView, Site } from '../lib/types';
import { DISPLAY_S_MAX, DISPLAY_S_MIN, UNLOCK_MS_MAX, UNLOCK_MS_MIN } from '../lib/types';
import { Empty, Spinner, Switch, useToast } from '../components/ui';

/** Zonas horarias IANA. Intl.supportedValuesOf existe en los navegadores actuales; si no, una lista corta. */
function timeZones(current: string): string[] {
  const fallback = ['America/Bogota', 'America/Lima', 'America/Mexico_City', 'America/Argentina/Buenos_Aires', 'America/Santiago',
    'America/Caracas', 'America/New_York', 'Europe/Madrid', 'UTC'];
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? fallback;
  return list.includes(current) ? list : [current, ...list];
}

const secondsText = (ms: number) => String(Math.round(ms) / 1000).replace('.', ',');
const parseNumber = (v: string) => Number(v.trim().replace(',', '.'));

export function Settings() {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.listDevices(), api.getSite()]);
      setDevices(d); setSite(s);
    } catch (e) { setError(e instanceof Error ? e.message : 'Error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Ajustes</h1>
        <p className="muted">Tiempos, nombre y pantalla de cada puerta. Los cambios llegan a la cerradura en unos 15 segundos.</p>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {devices === null ? <div className="card center-pad"><Spinner /></div>
        : devices.length === 0 ? <Empty icon={<SettingsIcon size={28} />} title="Aún no hay puertas" />
        : (
          <>
            {site && <SiteCard site={site} onSaved={load} />}
            {devices.map((d) => <DeviceCard key={d.id} device={d} onSaved={load} />)}
          </>
        )}
    </div>
  );
}

function SiteCard({ site, onSaved }: { site: Site; onSaved: () => Promise<void> }) {
  const { push } = useToast();
  const [tz, setTz] = useState(site.timezone);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => timeZones(site.timezone), [site.timezone]);
  useEffect(() => setTz(site.timezone), [site.timezone]);
  const changed = tz !== site.timezone;

  async function save() {
    setBusy(true);
    try {
      await api.updateSite(site.id, { timezone: tz });
      await onSaved();
      push({ kind: 'ok', title: 'Zona horaria guardada', text: 'Cambia los horarios de las tarjetas y la hora de la pantalla.' });
    } catch (e) {
      push({ kind: 'err', title: 'No se pudo guardar', text: e instanceof Error ? e.message : undefined });
    } finally { setBusy(false); }
  }

  return (
    <section className="card settings-card">
      <header className="settings-head">
        <span className="settings-icon" aria-hidden><Globe size={18} /></span>
        <div><h2>Lugar: {site.name}</h2><p className="muted small">Se aplica a todas las puertas de este lugar.</p></div>
      </header>
      <label className="field">
        <span>Zona horaria</span>
        <select value={tz} onChange={(e) => setTz(e.target.value)}>
          {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
        </select>
        <small className="muted">Gobierna los horarios de tarjetas e invitados y la hora que muestra la pantalla.</small>
      </label>
      <div className="settings-foot">
        <button className="btn btn-primary" disabled={!changed || busy} onClick={() => void save()}>
          {busy ? <Spinner /> : <Save size={16} aria-hidden />}Guardar
        </button>
      </div>
    </section>
  );
}

function DeviceCard({ device, onSaved }: { device: DeviceView; onSaved: () => Promise<void> }) {
  const { push } = useToast();
  const [name, setName] = useState(device.name);
  const [location, setLocation] = useState(device.location ?? '');
  const [unlock, setUnlock] = useState(secondsText(device.unlock_ms));
  const [display, setDisplay] = useState(String(device.display_msg_s));
  const [active, setActive] = useState(device.is_active);
  const [busy, setBusy] = useState(false);

  // Si la puerta cambia por fuera (otro administrador, otra pestaña), el formulario se actualiza.
  useEffect(() => {
    setName(device.name); setLocation(device.location ?? ''); setUnlock(secondsText(device.unlock_ms));
    setDisplay(String(device.display_msg_s)); setActive(device.is_active);
  }, [device.name, device.location, device.unlock_ms, device.display_msg_s, device.is_active]);

  const unlockMs = Math.round(parseNumber(unlock) * 1000);
  const displayS = parseNumber(display);
  const errors = {
    name: name.trim() ? null : 'El nombre no puede estar vacío',
    unlock: !unlock.trim() || !Number.isFinite(unlockMs) ? 'Escribe un número'
      : unlockMs < UNLOCK_MS_MIN || unlockMs > UNLOCK_MS_MAX ? `Entre ${secondsText(UNLOCK_MS_MIN)} y ${secondsText(UNLOCK_MS_MAX)} segundos` : null,
    display: !display.trim() || !Number.isInteger(displayS) ? 'Escribe un número entero'
      : displayS < DISPLAY_S_MIN || displayS > DISPLAY_S_MAX ? `Entre ${DISPLAY_S_MIN} y ${DISPLAY_S_MAX} segundos` : null,
  };
  const invalid = !!(errors.name || errors.unlock || errors.display);
  const patch: Partial<DeviceSettings> = {};
  if (name.trim() !== device.name) patch.name = name.trim();
  if ((location.trim() || null) !== device.location) patch.location = location.trim() || null;
  if (!errors.unlock && unlockMs !== device.unlock_ms) patch.unlock_ms = unlockMs;
  if (!errors.display && displayS !== device.display_msg_s) patch.display_msg_s = displayS;
  if (active !== device.is_active) patch.is_active = active;
  const changed = Object.keys(patch).length > 0;

  async function save() {
    if (invalid || !changed) return;
    setBusy(true);
    try {
      await api.updateDevice(device.id, patch);
      await onSaved();
      push({ kind: 'ok', title: 'Ajustes guardados', text: device.state.is_online ? 'La cerradura los recibirá en unos 15 segundos.' : 'La cerradura los recibirá al reconectarse.' });
    } catch (e) {
      push({ kind: 'err', title: 'No se pudo guardar', text: e instanceof Error ? e.message : undefined });
    } finally { setBusy(false); }
  }

  function discard() {
    setName(device.name); setLocation(device.location ?? ''); setUnlock(secondsText(device.unlock_ms));
    setDisplay(String(device.display_msg_s)); setActive(device.is_active);
  }

  return (
    <section className="card settings-card" aria-label={`Ajustes de ${device.name}`}>
      <header className="settings-head">
        <span className="settings-icon" aria-hidden><SettingsIcon size={18} /></span>
        <div><h2>{device.name}</h2><p className="muted small mono">{device.device_code}</p></div>
      </header>

      <div className="grid-2">
        <label className="field">
          <span>Nombre</span>
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
          {errors.name && <small className="field-error">{errors.name}</small>}
        </label>
        <label className="field">
          <span>Ubicación (opcional)</span>
          <input value={location} maxLength={60} onChange={(e) => setLocation(e.target.value)} placeholder="Ej. Entrada · Planta baja" />
        </label>
      </div>

      <div className="grid-2">
        <label className="field">
          <span>Tiempo que se mantiene abierta (segundos)</span>
          <input type="text" inputMode="decimal" autoComplete="off"
            value={unlock} onChange={(e) => setUnlock(e.target.value)} aria-invalid={!!errors.unlock} />
          {errors.unlock ? <small className="field-error">{errors.unlock}</small>
            : <small className="muted">Al abrir con tarjeta, desde la app, con un pase de invitado o con el botón de salida.</small>}
        </label>
        <label className="field">
          <span>Mensajes en la pantalla (segundos)</span>
          <input type="text" inputMode="numeric" autoComplete="off"
            value={display} onChange={(e) => setDisplay(e.target.value)} aria-invalid={!!errors.display} />
          {errors.display ? <small className="field-error">{errors.display}</small>
            : <small className="muted">Cuánto se ve «Bienvenido» o «Denegado». Si la puerta sigue abierta, se ve hasta que cierre.</small>}
        </label>
      </div>

      <div className="row between settings-switch">
        <div>
          <strong>Puerta habilitada</strong>
          <div className="muted small">Si la deshabilitas, ninguna tarjeta ni pase abre; la salida con el botón sigue funcionando.</div>
        </div>
        <Switch checked={active} onChange={setActive} label="Puerta habilitada" />
      </div>

      <div className="settings-foot">
        <button className="btn" disabled={!changed || busy} onClick={discard}>Descartar</button>
        <button className="btn btn-primary" disabled={!changed || invalid || busy} onClick={() => void save()}>
          {busy ? <Spinner /> : <Save size={16} aria-hidden />}Guardar cambios
        </button>
      </div>
    </section>
  );
}
