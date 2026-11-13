# OpenBIMStudio for Windows

The Windows desktop package bundles the Electron runtime and the production-built web application, including assets and WebAssembly files copied by the normal Vite build.

## Install

1. Download the latest OpenBIMStudio-Setup EXE from [GitHub Releases](https://github.com/amdghedy/openBIMstudio/releases).
2. Run the installer and choose an installation folder.
3. Launch OpenBIMStudio from the Desktop or Start Menu shortcut.

Node.js, npm, Git, and a separate browser are not required to run the installed desktop application.

## Build locally (Windows)

Use Node.js 24 and npm:

\`\`\`powershell
npm ci
npm run build
npm pkg set "devDependencies.electron=45.3.2" "devDependencies.electron-builder=26.0.12"
npm install --no-save --package-lock=false electron@45.3.2 electron-builder@26.0.12
npx electron-builder --config electron-builder.yml --win nsis --x64
\`\`\`

The installer is written to the release folder.

## GitHub Actions

Run the Windows Desktop Installer workflow manually from Actions, or let it run for relevant pushes to main. Successful runs upload a 64-bit Windows installer artifact. Pushing a version tag such as v0.75.0 also attaches the installer to the GitHub Release.

## Architecture and limitations

- The Electron main process starts a static HTTP server bound only to 127.0.0.1 on an operating-system-assigned port.
- The local server sends cross-origin isolation headers needed by SharedArrayBuffer and WebAssembly workers.
- The renderer uses context isolation, sandboxing, and disabled Node integration.
- The packaged UI comes from the normal production build.
- Optional collaboration services and external AI providers remain separately configured; the installer does not silently provision them.
- Initial target: Windows 10/11 x64. Code signing is not configured, so Windows SmartScreen may show an unrecognized-publisher warning until a signing certificate is added.
