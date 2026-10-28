import { NavLink, Outlet } from 'react-router-dom';
import { CreditCard, LayoutDashboard, LogOut, ShieldCheck, Ticket } from 'lucide-react';
import { useAuth } from '../context/Auth';
import { DEMO } from '../lib';

const nav = [
  { to: '/', label: 'Panel', icon: LayoutDashboard, end: true },
  { to: '/tarjetas', label: 'Tarjetas', icon: CreditCard, end: false },
  { to: '/invitados', label: 'Invitados', icon: Ticket, end: false },
];

export function Shell() {
  const { profile, signOut } = useAuth();
  const initials = (profile?.full_name ?? '?').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><ShieldCheck size={17} aria-hidden /></span><span>Control de Acceso</span></div>
        <nav aria-label="Principal">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={20} aria-hidden /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="side-user">
          <div className="avatar" aria-hidden>{initials}</div>
          <div className="side-user-info">
            <strong>{profile?.full_name}</strong>
            <span className="muted">Administrador</span>
          </div>
          <button className="icon-btn" aria-label="Cerrar sesión" onClick={() => void signOut()}><LogOut size={18} /></button>
        </div>
      </aside>

      <div className="main">
        {DEMO && <div className="demo-banner">MODO DEMO · datos simulados</div>}
        <header className="topbar-mobile">
          <div className="brand"><span className="brand-mark"><ShieldCheck size={17} aria-hidden /></span><span>Control de Acceso</span></div>
          <button className="icon-btn" aria-label="Cerrar sesión" onClick={() => void signOut()}><LogOut size={20} /></button>
        </header>
        <main><Outlet /></main>
      </div>

      <nav className="tabbar" aria-label="Principal">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            <Icon size={22} aria-hidden /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
