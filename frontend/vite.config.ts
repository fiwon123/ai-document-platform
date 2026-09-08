import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend proxies /v1/* to the backend API. Locally the backend runs on
// localhost:8000; inside the Docker frontend container the backend is a
// separate service reachable only by its compose name, so the compose file
// sets VITE_PROXY_TARGET=http://backend:8000.
const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:8000";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/v1": proxyTarget },
  },
});
