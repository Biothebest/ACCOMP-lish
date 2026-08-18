import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4318,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/events": "http://127.0.0.1:4317",
    },
  },
});
