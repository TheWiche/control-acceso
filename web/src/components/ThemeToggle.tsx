import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme';

/** Alterna entre modo claro y oscuro. Los dos iconos se cruzan con una rotación corta. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button type="button" className={`icon-btn theme-toggle ${className}`} onClick={toggle}
      aria-label={dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'} title={dark ? 'Modo claro' : 'Modo oscuro'}>
      <Sun size={19} className="ti-sun" aria-hidden />
      <Moon size={19} className="ti-moon" aria-hidden />
    </button>
  );
}
