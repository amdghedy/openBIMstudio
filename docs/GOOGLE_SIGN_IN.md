# Google Sign-In (Open BIM Studio)

Users sign in with **Continue with Google** on the Account button (welcome page + ribbon).

## 1. Google Cloud Console

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. **Create credentials → OAuth client ID → Web application**.
3. **Authorized JavaScript origins** (every host users open), for example:
   - `https://openbimstudio.amdghedy.workers.dev`
   - `https://open-bi-mstudio.vercel.app`
   - `http://localhost:5173`
4. **Authorized redirect URIs** (exact path):
   - `https://openbimstudio.amdghedy.workers.dev/api/auth/google/callback`
   - Same path on any host that serves the Worker `/api/auth/*` routes
5. Copy **Client ID** and **Client Secret**.

## 2. Cloudflare Worker secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

## 3. Verify

- `GET /api/auth/google/status` → `{ "configured": true }`
- App → **Sign in** → **Continue with Google** → account name on the button

Email/password remains available if Google is not configured.
