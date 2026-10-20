import { defineConfig } from "vite";

import react from "@vitejs/plugin-react";
/**
 * Vite config for Open BIM Studio.
 *
 * Proxies exist because some AI providers do not send permissive CORS
 * headers for browser requests:
 *   /ollama     → http://localhost:11434   (Ollama)
 *   /lmstudio   → http://localhost:1234    (LM Studio; CORS off by default)
 *   /anthropic  → https://api.anthropic.com (Anthropic; no CORS headers)
 *
 * Providers that DO send CORS headers (OpenAI, Groq, Gemini, DeepSeek,
 * Mistral, Together, OpenRouter, Fireworks, Perplexity, xAI) are called
 * directly — no proxy needed.
 */
export default defineConfig({
  plugins: [react(), crossOriginIsolation()],
  define: {
    __WEB_IFC_SCRIPT_URL__: JSON.stringify('/web-ifc/web-ifc-api.js'),
  },
  esbuild: { target: "esnext" },
  build: {
    target: "esnext",
    // Large vendors (web-ifc WASM, @thatopen/components, monaco) inherently
    // exceed 1.5 MB; raise the limit so CI build logs stay clean.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          // Group large vendor libs into separate chunks for better caching
          // and to silence the > 500 KB build warning.
          "react-vendor": ["react", "react-dom", "react-redux", "@reduxjs/toolkit"],
          "mui-vendor": ["@mui/material", "@mui/lab", "@emotion/react", "@emotion/styled"],
          "three-vendor": ["three", "three-mesh-bvh", "three-csg-ts"],
          "thatopen-vendor": [
            "@thatopen/components",
            "@thatopen/components-front",
            "@thatopen/fragments",
            "@thatopen/ui",
            "@thatopen/ui-obc",
          ],
          "tldraw-vendor": [
            "@tldraw/editor",
          ],
          "monaco-vendor": ["monaco-editor"],
          "ifc-vendor": ["web-ifc"],
          "yjs-vendor": ["yjs", "y-websocket"],
        },
      },
    },
  },
  resolve: { dedupe: ["lit", "lit-html", "lit-element", "@lit/reactive-element"] },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
    proxy: {
      "/ollama": {
        target: "http://localhost:11434",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/ollama/, ""),
      },
      "/lmstudio": {
        target: "http://localhost:1234",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/lmstudio/, ""),
      },
      "/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/anthropic/, ""),
      },
    },
  },
  preview: {
    port: 3000,
    proxy: {
      "/ollama": {
        target: "http://localhost:11434",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/ollama/, ""),
      },
      "/lmstudio": {
        target: "http://localhost:1234",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/lmstudio/, ""),
      },
      "/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/anthropic/, ""),
      },
    },
  },
});
// --- OpenBIMStudio :: COOP/COEP for SharedArrayBuffer (web-ifc-mt) ---
function crossOriginIsolation() {
  return {
    name: "cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        next();
      });
    },
  };
}