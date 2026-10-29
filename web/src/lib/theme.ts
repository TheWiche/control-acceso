import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'ca-theme';
const EVENT = 'ca-theme-change';
const META_COLOR: Record<Theme, string> = { light: '#f5f8f7', dark: '#0e1315' };

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }   // almacenamiento bloqueado (modo privado, datos del sitio desactivados)
}

function system(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** El script de index.html ya fijó data-theme antes del primer render; aquí solo se lee. */
function current(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : stored() ?? system();
}

function apply(theme: Theme, animate: boolean) {
  const root = document.documentElement;
  if (animate) {
    // Durante ~0,4 s todo el árbol transiciona color/fondo/borde (ver .theme-anim en styles.css).
    root.classList.add('theme-anim');
    window.setTimeout(() => root.classList.remove('theme-anim'), 450);
  }
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[theme]);
  window.dispatchEvent(new Event(EVENT));
}

export function setTheme(theme: Theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* sin persistencia: vale solo para esta sesión */ }
  apply(theme, true);
}

function subscribe(cb: () => void) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  // Si la persona nunca eligió, se sigue al sistema operativo en vivo.
  const onSystem = () => { if (!stored()) apply(system(), true); };
  window.addEventListener(EVENT, cb);
  mq.addEventListener('change', onSystem);
  return () => { window.removeEventListener(EVENT, cb); mq.removeEventListener('change', onSystem); };
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as Theme);
  return { theme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
}
