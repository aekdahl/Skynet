import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API/WS proxy target — the local server port. The desktop dev launcher points
// this at the desktop server (8099); plain `pnpm dev` uses the default 8080.
const apiPort = process.env.SKYNET_SERVER_PORT || "8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
});
