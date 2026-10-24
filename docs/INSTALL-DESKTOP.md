# Run Open BIM Studio like desktop software

Open BIM Studio is an installable web app (PWA). Once installed it opens in its own window, starts
from the Start menu / Dock / desktop icon, works **offline**, and keeps all projects on your computer.

## Install
1. Start it locally: double-click `start-windows.bat` (Windows) or run `./start-mac-linux.sh`
   (it installs dependencies once, builds, and opens http://localhost:3000). Or use the hosted copy.
2. In Chrome or Edge click the **install icon** in the address bar, or press `Ctrl+P` and run
   **Install as desktop app (works offline)**.
3. Launch it from your Start menu / Applications. After the first visit the whole app is cached, so it
   no longer needs the server or an internet connection.

## Your files stay local
- **File → Save project to file (.obsproj)** writes a real file on your disk; later saves overwrite it.
- **Open project from file** loads it back. The installed app also registers as an opener for
  `.obsproj`, `.ifc` and `.frag`: right-click a file, *Open with → Open BIM Studio*.
- Browser storage is requested as persistent so it isn't cleaned up automatically. Keep a `.obsproj`
  copy as your backup.

## Updating
When a new version is built, the app shows "A new version is ready" — close and reopen it to update.

## Notes
- Offline caching only exists in the production build (`npm run start:local` or `npm run build`),
  not in `npm run dev`.
- The local-AI proxies (`/ollama`, `/lmstudio`) need the preview server running, and are never cached.
