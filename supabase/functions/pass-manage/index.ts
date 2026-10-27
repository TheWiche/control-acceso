// Requiere JWT de admin u operador. Crea o regenera accesos de invitado.
// El token y el PIN se devuelven UNA sola vez; en la base solo quedan sha256 / bcrypt.
import { handler, HttpError, requireRole, serviceClient } from '../_shared/common.ts';

const isTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const DAY = 86_400_000;

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const caller = await requireRole(req, db, ['admin', 'operator']);

  if (body.action === 'rotate') {
    if (typeof body.pass_id !== 'string') throw new HttpError(400, 'pass_id requerido');
    const { data, error } = await db.rpc('fn_rotate_guest_pass', {
      p_pass_id: body.pass_id, p_pin: typeof body.pin === 'string' && body.pin ? body.pin : null,
    });
    if (error) throw new HttpError(400, error.message);
    return { ok: true, ...data };
  }

  if (body.action !== 'create') throw new HttpError(400, 'Acción desconocida');

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (label.length < 1 || label.length > 80) throw new HttpError(400, 'El nombre del invitado es obligatorio (máx. 80 caracteres)');

  const from = new Date(String(body.valid_from ?? ''));
  const until = new Date(String(body.valid_until ?? ''));
  if (isNaN(+from) || isNaN(+until)) throw new HttpError(400, 'Fechas inválidas');
  if (until <= from) throw new HttpError(400, 'El fin debe ser posterior al inicio');
  if (until.getTime() - from.getTime() > 366 * DAY) throw new HttpError(400, 'La vigencia máxima es de 1 año');
  if (until.getTime() < Date.now()) throw new HttpError(400, 'El acceso ya estaría vencido');

  let days: number[] | null = null;
  if (Array.isArray(body.allowed_days) && body.allowed_days.length < 7) {
    days = [...new Set(body.allowed_days.map(Number))].sort();
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new HttpError(400, 'Días inválidos');
  }

  const hasWindow = body.time_start != null || body.time_end != null;
  if (hasWindow && (!isTime(body.time_start) || !isTime(body.time_end) || body.time_start === body.time_end)) {
    throw new HttpError(400, 'Horario inválido');
  }

  const maxUses = body.max_uses == null ? null : Number(body.max_uses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) throw new HttpError(400, 'Límite de usos inválido');

  const codes = Array.isArray(body.device_codes) ? body.device_codes.filter((c): c is string => typeof c === 'string') : [];
  if (!codes.length) throw new HttpError(400, 'Elige al menos una puerta');
  const { data: devs } = await db.from('devices').select('id').in('device_code', codes).eq('is_active', true);
  if (!devs || devs.length !== new Set(codes).size) throw new HttpError(400, 'Alguna puerta no existe o está deshabilitada');

  const phone = typeof body.guest_phone === 'string' ? body.guest_phone.replace(/[^\d+]/g, '').slice(0, 20) : null;

  const { data, error } = await db.rpc('fn_create_guest_pass', {
    p_created_by: caller.id, p_label: label, p_valid_until: until.toISOString(), p_device_ids: devs.map((d) => d.id),
    p_valid_from: from.toISOString(), p_guest_phone: phone || null, p_notes: null,
    p_allowed_days: days, p_time_start: hasWindow ? body.time_start : null, p_time_end: hasWindow ? body.time_end : null,
    p_max_uses: maxUses, p_pin_length: Number(body.pin_length) || 6, p_pin: typeof body.pin === 'string' && body.pin ? body.pin : null,
  });
  if (error) throw new HttpError(400, error.message);
  return { ok: true, ...data };
}));
