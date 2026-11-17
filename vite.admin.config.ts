import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * The platform administration app is built and hosted SEPARATELY from the shop app (different domain, no offline cache,
 * no service worker): `npm run build:admin` writes dist-admin/. Put it behind its own address and, ideally, an IP allow-list.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174 },
  build: { outDir: 'dist-admin', emptyOutDir: true, rollupOptions: { input: 'admin.html' } },
})
