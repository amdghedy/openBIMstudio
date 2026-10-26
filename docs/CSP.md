# Content Security Policy — openBIMstudio

Remediation program Phase 1.5. **Status: drafted and fully specified, but
NOT yet enabled in `index.html`.** Production-boot verification found a real
incompatibility that must be resolved first (see "Enablement blocker" below).
The API server already sends a strict header policy
(`server/security.mjs`); the app-level policy below is ready to apply once
the blocker is closed. **Any change to the policy must be verified against a
production build** (`npm run build && npm run preview`) with the browser
console open — a too-strict directive breaks features silently; a too-loose
one weakens the platform.

## Enablement blocker (verified 2026-10-26)

With the full policy applied as a meta tag, the ThatOpen Fragments worker
(`@thatopen/fragments/dist/Worker/worker.mjs`, emitted as
`assets/worker-*.mjs`) fails during boot ("Fragments worker failed to load…
Failed to fetch") and the app aborts startup; with the meta removed the same
build boots fully. The exact directive-level cause needs the Phase 7 browser
E2E harness (console-violation capture) to iterate safely — likely the
worker's module-import chain requires either `worker-src blob:` handling for
nested imports or an additional `script-src` source for the worker's chunk
graph. Do not enable the policy piecemeal by loosening directives blindly;
close the blocker with evidence instead.

## Directive-by-directive justification

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'self'` | Everything not explicitly listed falls back to same-origin only. |
| `script-src` | `'self'` `'wasm-unsafe-eval'` `https://cdn.jsdelivr.net` | Bundled app + classic scripts under `/js/`, `/plugins/` are same-origin. `'wasm-unsafe-eval'` is required by web-ifc and LibreDWG WebAssembly compilation (no general `'unsafe-eval'` granted). `cdn.jsdelivr.net` is required **only** by the PDF underlay feature, which loads PDF.js 4.4.168 on demand (`src/modules/pdf-underlay/pdf-underlay.ts`). PDFs are parsed locally; no project data is uploaded anywhere by that feature. |
| `worker-src` | `'self'` `blob:` `https://cdn.jsdelivr.net` | Clash worker is a bundled same-origin worker. `blob:` covers workers built from inline bundles (ThatOpen fragments pipeline, Monaco-style patterns). PDF.js worker comes from jsdelivr together with the library. |
| `style-src` | `'self'` `'unsafe-inline'` | Emotion/MUI inject runtime `<style>` elements — impossible without `'unsafe-inline'`. This is the industry-standard trade-off for CSS-in-JS; scripts remain restricted. |
| `img-src` | `'self'` `data:` `blob:` | Icons/manifest assets are same-origin; screenshots, IFC texture atlases and canvas exports appear as data/blob URLs. |
| `font-src` | `'self'` `data:` | No external font CDN is used. |
| `connect-src` | `'self'` + enumerated providers + localhost any-port | See the provider table below. `http://localhost:*` / `http://127.0.0.1:*` (and `ws:`/`wss:`) cover the local collaboration server default (`http://localhost:4000/api`) and the **default local AI provider** (Ollama at `http://localhost:11434`). |
| `frame-src` | `'none'` | The app uses no iframes (the Autodesk Viewer is opened in a new tab via `window.open`, never embedded). |
| `object-src` | `'none'` | No plugins/objects — kills legacy plug-in attack surface. |
| `base-uri` | `'self'` | Prevents `<base>` hijacking of relative URLs. |
| `form-action` | `'self'` | No cross-site form posts. |

Note: `frame-ancestors` cannot be expressed in a `<meta>` policy; the API
server sets it via header (`server/security.mjs` `SECURITY_HEADERS`). For
strict clickjacking protection of the app itself, deploy behind a reverse
proxy that sends the same policy as an HTTP header (headers support
`frame-ancestors`).

## Network endpoint inventory (connect-src)

Endpoints are also listed in `docs/engineering/BASELINE.md` §7. Every
outbound connection is opt-in through the user's own configuration:

| Provider | Host | Feature | Privacy note |
|---|---|---|---|
| APS (Autodesk Platform Services) | `developer.api.autodesk.com` | RVT/NWD/NWC→IFC conversion | Explicit user action + configured credentials; files leave the machine only after upload consent |
| Microsoft Graph / SharePoint | `graph.microsoft.com`, `*.sharepoint.com` | CDE provider | User-configured |
| Dalux | `field.dalux.com` | CDE provider | User-configured |
| Google Drive / Gemini | `www.googleapis.com`, `generativelanguage.googleapis.com` | CDE / AI provider | User-configured |
| AI providers | `api.openai.com`, `api.anthropic.com`, `api.groq.com`, `openrouter.ai`, `api.cerebras.ai`, `api.deepseek.com`, `api.mistral.ai`, `api.together.xyz` | AI assistant | Auto-redaction applies before any cloud call (`src/features/ai-privacy.ts`) |
| Dropbox | `api.dropboxapi.com`, `content.dropboxapi.com` | File storage | User-configured |
| Local services | `localhost` / `127.0.0.1` any port, `ws://`/`wss://` localhost | Collaboration server, local AI (Ollama), dev HMR | Local-first default |

## Known limitation (visible, documented)

The AI provider settings accept an **arbitrary endpoint URL** (e.g. a LAN
inference server at `http://192.168.1.50:1234`). A static CSP cannot
enumerate dynamic hosts, so such endpoints are blocked by `connect-src` unless
the deployment extends the policy. Affected users should run the app behind a
reverse proxy that appends their endpoint to the CSP header, or front their
inference server via an SSH/localhost tunnel (covered by `http://localhost:*`).
The UI shows the provider's connection error in that case; this limitation is
recorded in `docs/engineering/BASELINE.md`.

## Maintenance rules

1. Adding a new cloud provider → add its host to `connect-src` **and** to the
   table above **and** to `docs/INTEROPERABILITY_MATRIX.md` privacy column.
2. Adding a new CDN-loaded library → `script-src`/`worker-src` entry + a
   pinned version + a privacy note in the feature docs.
3. Never add blanket `https:` to `connect-src` — it would silently allow any
   project data to leave the machine and defeat the AI redaction audit trail.
4. Never add `'unsafe-eval'` — WASM uses `'wasm-unsafe-eval'`; if a dependency
   demands full eval, replace the dependency.
5. Verify: `npm run build && npm run preview`, open the app, run an IFC
   import, a clash run, an export, and the AI panel with the console open —
   zero CSP violations is the acceptance bar (Phase 7 browser E2E automates
   console-error collection).
