# LinkedIn personal-profile publishing

This integration uses LinkedIn's official OAuth 2.0 authorization-code flow and the self-service **Share on LinkedIn** product. It publishes text posts to the authenticated personal member profile only. It does not use browser automation, scraping, Metricool, or an unofficial endpoint.

## What is implemented

- OAuth consent at `/api/linkedin/connect`.
- OAuth callback at `/api/linkedin/callback`, with one-time state validation.
- Member identity lookup using OpenID Connect.
- Private access-token storage in a Cloudflare Durable Object.
- Authenticated text publishing at `/api/linkedin/publish`.
- Authenticated connection status and local disconnect endpoints.
- A manual GitHub Actions workflow to publish a supplied text post.

The access token is not returned by the Worker. LinkedIn currently documents a 60-day access-token lifetime. Programmatic refresh tokens are limited to approved partners, so this implementation requires reconnecting when the token expires.

## 1. Create and configure a LinkedIn developer app

1. Open the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) and create an app.
2. Complete the app's required association/verification steps as prompted by LinkedIn.
3. On the **Products** tab, request/enable:
   - **Share on LinkedIn** (`w_member_social`)
   - **Sign In with LinkedIn using OpenID Connect** (`openid`, `profile`)
4. On the **Auth** tab, add this exact redirect URL after choosing the production Worker hostname:

   `https://YOUR-WORKER-HOST/api/linkedin/callback`

5. Copy the Client ID and Client Secret. Never commit or share the Client Secret.

LinkedIn controls product availability and can change its review requirements. The API code cannot bypass LinkedIn's app/product approval or account restrictions.

## 2. Configure Cloudflare Worker secrets

From the repository root, set the secrets on the Cloudflare account that owns the Worker:

```bash
npx wrangler secret put LINKEDIN_CLIENT_ID
npx wrangler secret put LINKEDIN_CLIENT_SECRET
npx wrangler secret put LINKEDIN_REDIRECT_URI
npx wrangler secret put LINKEDIN_PUBLISH_SECRET
```

Use the same exact HTTPS callback URL in the LinkedIn app and `LINKEDIN_REDIRECT_URI`. Generate a strong independent publishing secret, for example with `openssl rand -hex 32`, and enter it when Wrangler prompts for `LINKEDIN_PUBLISH_SECRET`. Do not paste secrets into source files, issues, pull requests, or chat.

Optional Worker variable: `LINKEDIN_VERSION`. If omitted, the implementation defaults to `202610`, which LinkedIn currently lists as the October 2026 latest Marketing API version. The version is pinned in the request header and should be updated on the monthly release cadence.

Deploy the Worker after the branch is reviewed and merged:

```bash
npm install
npx wrangler@4 deploy
```

The Wrangler configuration adds a dedicated SQLite-backed Durable Object namespace for the token vault. Deploying applies its migration.

## 3. Connect your personal profile

While signed in to LinkedIn, visit:

`https://YOUR-WORKER-HOST/api/linkedin/connect`

Review the requested permissions and authorize the app. A successful callback confirms that the personal member identity and access token were stored server-side.

## 4. Configure GitHub Actions

In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:

- `LINKEDIN_WORKER_URL`: the Worker base URL, for example `https://YOUR-WORKER-HOST`.
- `LINKEDIN_PUBLISH_SECRET`: the same strong secret configured on the Worker.

Then open **Actions → Publish LinkedIn post → Run workflow**, enter the final post text, and run it. The workflow publishes only when manually triggered. It does not auto-generate content or publish on a schedule.

## 5. Verify connection and publish

The status endpoint requires the publishing secret:

```bash
curl -H "Authorization: Bearer $LINKEDIN_PUBLISH_SECRET" \
  "$LINKEDIN_WORKER_URL/api/linkedin/status"
```

Use the manual GitHub Actions workflow for a real post. Start with a short test post that you are comfortable publishing publicly.

## Scope and safety limitations

- Personal profile only. Company-page publishing is not included.
- Text-only posts in this first implementation. Image/video upload is a separate media-upload workflow and is not claimed as supported.
- The publishing endpoint is protected by a high-entropy bearer secret. Keep it in Cloudflare and GitHub Actions secrets only.
- OAuth access tokens are stored in a private Durable Object and never sent to the browser after callback.
- There is no automatic token refresh for apps without LinkedIn's partner-only refresh capability. Reauthorize when the token expires.
- The workflow is manual dispatch only. The existing ChatGPT content-preparation automation remains draft-only until end-to-end publishing is configured and verified.
- Do not deploy this to production until the LinkedIn API version, app products, OAuth callback, Cloudflare secrets, and Durable Object migration have been checked in the target Cloudflare account.
