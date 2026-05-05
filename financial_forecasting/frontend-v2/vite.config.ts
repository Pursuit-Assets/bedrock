import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Frontend-v2 dev server runs on :4200 to keep :3000 free for the
// legacy CRA app. Both proxy to the FastAPI backend on :8000.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 4200,
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL || "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      // /auth/me, /auth/google, /auth/salesforce, /auth/logout, etc. all
      // live on the FastAPI backend. Without this proxy entry the browser
      // hits Vite directly, which 404s, and the auth state breaks.
      "/auth": {
        target: process.env.VITE_API_URL || "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
