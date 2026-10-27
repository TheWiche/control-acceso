import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

/**
 * Clave con privilegios de servicio (bypassa RLS). SOLO dentro de Edge Functions.
 * Proyectos nuevos: SUPABASE_SECRET_KEYS = JSON {"default": "sb_secret_..."}.
 * Proyectos antiguos: SUPABASE_SERVICE_ROLE_KEY (legacy, se deprecará).
 */
function serviceKey(): string {
  const json = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (json) {
    try {
      const keys = JSON.parse(json) as Record<string, string>;
      if (keys.default) return keys.default;
      const first = Object.values(keys)[0];
      if (first) return first;
    } catch { /* formato inesperado: probar la legacy */ }
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('No hay SUPABASE_SECRET_KEYS ni SUPABASE_SERVICE_ROLE_KEY en el entorno');
}

let cached: SupabaseClient | null = null;
export const serviceClient = (): SupabaseClient =>
  (cached ??= createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  }));

// APP_ORIGIN = orígenes permitidos separados por coma (p. ej. https://usuario.github.io,http://localhost:5173).
// CORS no es una barrera de seguridad (la autenticación es JWT / token+PIN / clave del dispositivo);
// solo evita que otros sitios web usen la API desde el navegador. Sin APP_ORIGIN se permite cualquier origen.
export function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('APP_ORIGIN') ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = req.headers.get('origin') ?? '';
  const allowOrigin = !allowed.length ? (origin || '*') : allowed.includes(origin) ? origin : allowed[0]!;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    // Refleja lo que pide el navegador: supabase-js puede añadir cabeceras nuevas entre versiones.
    'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') ?? 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Envoltorio común: CORS, solo POST, JSON, errores uniformes. */
export function handler(fn: (req: Request, body: Record<string, unknown>) => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Método no permitido' }, 405);
    try {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return json(req, await fn(req, body));
    } catch (e) {
      if (e instanceof HttpError) return json(req, { ok: false, error: e.message }, e.status);
      console.error(e);
      return json(req, { ok: false, error: 'Error interno' }, 500);
    }
  };
}

export const clientIp = (req: Request): string | null => {
  const raw = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  return raw && /^[0-9a-fA-F:.]+$/.test(raw) ? raw : null;
};

export interface Caller { id: string; role: 'admin' | 'operator' | 'user'; full_name: string }

/** Verifica el JWT y exige uno de los roles. La autoridad es la tabla profiles, NO el JWT/user_metadata. */
export async function requireRole(req: Request, db: SupabaseClient, roles: Caller['role'][]): Promise<Caller> {
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'Falta la sesión');
  const { data: { user }, error } = await db.auth.getUser(jwt);
  if (error || !user) throw new HttpError(401, 'Sesión inválida o vencida');
  const { data: p } = await db.from('profiles').select('id, role, status, full_name').eq('auth_user_id', user.id).maybeSingle();
  if (!p || p.status !== 'active' || !roles.includes(p.role)) throw new HttpError(403, 'No tienes permisos para esta acción');
  return { id: p.id, role: p.role, full_name: p.full_name };
}

export async function rateLimit(db: SupabaseClient, key: string, limit: number, windowSql: string): Promise<boolean> {
  const { data, error } = await db.rpc('fn_rate_limit', { p_key: key, p_limit: limit, p_window: windowSql });
  if (error) throw error;
  return data === true;
}
