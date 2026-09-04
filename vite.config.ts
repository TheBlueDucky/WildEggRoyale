import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // host:true exposes the dev server on your LAN so you can test on a second
    // device. Note: browsers only treat localhost as a secure context, so for
    // cross-device testing prefer a tunnel (or run two tabs on localhost).
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
  },
});
