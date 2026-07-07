import { defineConfig } from "vite";

// Vite options tailored for Tauri development.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
