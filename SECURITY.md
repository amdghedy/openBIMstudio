# Security & privacy

Open BIM Studio is local-first: projects, models and settings stay in your browser or in `.obsproj`
files you choose to save. Nothing is sent anywhere unless you turn on a feature that needs the network.

## What protects your data

| Area | Protection |
|---|---|
| API keys & tokens (AI providers, CDE connections) | Encrypted at rest with AES-256-GCM using a non-extractable key held in IndexedDB. Old plaintext values are migrated automatically. |
| Project files | **File → Save project to file, encrypted with a password** (AES-256-GCM, PBKDF2-SHA-256, 600 000 iterations). Encrypted files are never auto-saved back in plain text. |
| Cloud AI | Local models (Ollama, LM Studio, LAN hosts) need no approval. The first use of any other host asks you explicitly and is remembered per host. |
| Imported files | Text coming from IFC / DXF / IDS / family files is HTML-escaped before it is shown. Family formulas run in a small interpreter with no access to scripts, globals or the DOM. |
| Plugins | Loaded only from the app's own `/plugins/<id>/` folder; ids and entry paths are validated; the all-powers wildcard is refused for non-first-party plugins. |
| Web headers | `nosniff`, `no-referrer`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, camera / microphone / location blocked, same-origin resource policy, HSTS (hosted). |
| Collaboration server | Binds to `127.0.0.1` by default; browser requests only from an allowed-origin list; optional bearer token; ids validated; uploads restricted to model/CAD types with sanitised file names. |

## Running the collaboration server safely

```
# local only (default)
node server/index.mjs

# share on a network: always set a token and the origins that may call it
HOST=0.0.0.0 OBS_SERVER_TOKEN=<long random value> OBS_ALLOWED_ORIGINS=https://studio.example node server/index.mjs
```

Put it behind HTTPS (a reverse proxy) before exposing it beyond a trusted network. Autodesk conversion
credentials (`APS_CLIENT_ID`, `APS_CLIENT_SECRET`) are read from the environment on the server only.

## Good practice
- Keep a password-protected `.obsproj` backup of important projects; a forgotten password cannot be recovered.
- Use **Privacy: forget saved API keys, tokens and AI approvals** (Ctrl+P) on shared computers.
- Revoke any access token that was ever pasted into a chat or an issue.
- Rotate keys you gave to cloud AI providers if a device is lost.

## Reporting a vulnerability
Please open a private security advisory on the GitHub repository rather than a public issue.
