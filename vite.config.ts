import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";
import tauriConfig from "./src-tauri/tauri.conf.json";

const appVersion = tauriConfig.version ?? packageJson.version;

export default defineConfig({
  plugins: [react()],
  build: {
    // MapLibre and the tree-shaken ECharts runtime are intentionally loaded as
    // separate, deferred chunks. Keep the warning threshold just above those
    // measured vendor payloads so a future size regression remains visible.
    chunkSizeWarningLimit: 850,
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173
  }
});
