import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages sirve en /<repo>/. El workflow define VITE_BASE=/<repo>/ ; en local es "/".
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Control de Acceso',
        short_name: 'Acceso',
        description: 'Panel de administración del sistema de control de acceso',
        lang: 'es',
        theme_color: '#131416',
        background_color: '#131416',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Solo se precachean los assets de la app; las llamadas a Supabase nunca se cachean.
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], navigateFallback: null },
    }),
  ],
});
