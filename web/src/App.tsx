import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/Auth';
import { Shell } from './components/Shell';
import { Spinner, ToastProvider } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Cards } from './pages/Cards';
import { Guests } from './pages/Guests';
import { Settings } from './pages/Settings';
import { GuestKey } from './pages/GuestKey';
import { CONFIG_MISSING } from './lib';

function Gate() {
  const { profile, loading } = useAuth();
  if (loading) return <div className="splash"><Spinner /></div>;
  if (!profile) return <Login />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="tarjetas" element={<Cards />} />
        <Route path="invitados" element={<Guests />} />
        <Route path="ajustes" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function Admin() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  );
}

export default function App() {
  if (CONFIG_MISSING) {
    return (
      <div className="login"><div className="login-card">
        <h1>Falta la configuración</h1>
        <p className="muted">Define <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> (archivo <code>.env.local</code> o variables del repositorio) y vuelve a compilar.</p>
      </div></div>
    );
  }
  // HashRouter: GitHub Pages no tiene fallback de SPA y el token del pase viaja en el fragmento (#/p/<token>).
  // La vista del invitado queda FUERA de AuthProvider: no necesita ni toca ninguna sesión.
  return (
    <HashRouter>
      <Routes>
        <Route path="/p/:token" element={<GuestKey />} />
        <Route path="*" element={<Admin />} />
      </Routes>
    </HashRouter>
  );
}
