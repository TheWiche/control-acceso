import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/Auth';
import { DEMO } from '../lib';
import { Spinner } from '../components/ui';

export function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState(DEMO ? 'admin@demo.local' : '');
  const [password, setPassword] = useState(DEMO ? 'demo1234' : '');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await signIn(email, password); }
    catch (err) {
      const m = err instanceof Error ? err.message : 'Error desconocido';
      setError(/invalid login/i.test(m) ? 'Correo o contraseña incorrectos.' : m);
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark"><ShieldCheck size={30} aria-hidden /></div>
        <h1>Control de Acceso</h1>
        <p className="muted">Panel de administración</p>

        <label className="field">
          <span>Correo</span>
          <input type="email" autoComplete="username" inputMode="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="tu@correo.com" />
        </label>
        <label className="field">
          <span>Contraseña</span>
          <div className="input-row">
            <input type={show ? 'text' : 'password'} autoComplete="current-password" required value={password}
              onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="icon-btn" aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setShow((s) => !s)}>
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </label>

        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? <Spinner /> : 'Entrar'}</button>
        {DEMO && <p className="muted small center">Modo demo: cualquier credencial funciona.</p>}
      </form>
    </div>
  );
}
