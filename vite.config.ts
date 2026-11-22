import { defineConfig } from 'vite';

export default defineConfig({
  // MapLibre v6 spawns its own web worker from its dist folder; Vite's
  // dependency pre-bundling breaks that path, so leave it unbundled in dev.
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
