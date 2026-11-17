import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  server: {
    port: 3000,
    host: "127.0.0.1",
    proxy: {
      "/api/app/v1": { target: "http://127.0.0.1:3001", changeOrigin: false },
    },
  },
  plugins: [react()],
  build: { sourcemap: false },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
