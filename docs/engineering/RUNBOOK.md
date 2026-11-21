# openBIMstudio — Maintainer runbook

**Purpose:** a new maintainer (or the current one, after time away) can keep this
project running, deploy it, rotate its secrets, and recover it, in about two
hours, using only this file plus the repository. No secret *value* appears
anywhere in this file — only secret *names*, where they live, and how to rotate
them. Secret values live in the stores named below and nowhere else.

**Verified against:** `main` at `bb0f55c` ("feat(ifc): authored IFC export emits
IfcXxxType + IfcRelDefinesByType … (#256)"), 2026-11-21. Anything marked
**unknown** could not be evidenced from the repo, workflows, or docs on that
date; it is a question for the owner, not a guess.

**Related:** decision notes in `docs/engineering/decisions/` (why the current
controls look the way they do); `SECURITY.md` (product security model);
`docs/LINKEDIN_PUBLISHING.md` (LinkedIn OAuth setup);
`docs/engineering/ISSUES.md` (tracker state).

---

## 1. What this project is, in one paragraph

openBIMstudio is an open, local-first BIM workspace that runs in the browser
(public repo `amdghedy/openBIMstudio`, default branch `main`, JavaScript /
TypeScript + a Rust CAD engine compiled to WebAssembly). Most users never touch
a server: projects live in the browser or in `.obsproj` files. Three things
*do* need hosted infrastructure: the live demo (Vercel), the Cloudflare Worker
that serves the app's worker build and the LinkedIn publishing endpoints, and
the optional local collaboration server (`server/index.mjs`) that users run
themselves. There is one maintainer and no second human with access to any
account below. That is the risk this runbook exists to bound.

## 2. Accounts and services

Only accounts/services evidenced from the repo (workflows, configs, docs, code)
are listed. If it is not here, no evidence for it was found in the repo.

| # | Service / account | What it is used for | Evidence in repo | Who holds it |
|---|---|---|---|---|
| 1 | **GitHub** — repo `amdghedy/openBIMstudio` (public), owner `amdghedy` | Source of truth; Issues/PRs; GitHub Actions CI (9 workflows); branch protection (see §6) | `README.md`, `.github/workflows/` | Owner: amdghedy |
| 2 | **GitHub Actions** — runners `ubuntu-latest` / `windows-latest`, Node 22/24 | CI (`unit-tests.yml`: jobs `Build and quality checks`, `Browser smoke (blocking, Chromium)`); CodeQL; nightly IFC fuzz; cross-browser nightly (advisory); vendor-reader and RVT builds | `.github/workflows/*.yml` | Same GitHub account; no extra login |
| 3 | **Vercel** — project serving `https://open-bi-mstudio.vercel.app` | Live demo (static Vite build). Deploys on push to `main` via the Vercel GitHub integration | `vercel.json`, `README.md:24,31,543`, `docs/engineering/BASELINE.md:13` ("Deploy to Vercel ✅") | Owner (Vercel dashboard). **Unknown:** which Vercel account/project the integration points at — no Vercel secret or project id exists in the repo; owner to confirm |
| 4 | **Cloudflare** — Worker `openbimstudio` | Serves the built app + worker APIs at `https://openbimstudio.amdghedy.workers.dev/`; Durable Objects `VisitCounter` (`COUNTER`), `LinkedInVault` (`LINKEDIN_VAULT`), `AuthVault` (`AUTH`) | `wrangler.jsonc`, `.github/workflows/deploy.yml`, `api/visits.ts:19`, `.github/ISSUE_TEMPLATE/config.yml:4` | Owner: Cloudflare account `amdghedy` (per the `*.workers.dev` subdomain) |
| 5 | **npm registry** — `https://registry.npmjs.org/` | Dependency install only (`npm ci --legacy-peer-deps`). There is **no** publish workflow and no npm token in the repo | `.npmrc`, `.github/workflows/deploy.yml`, `unit-tests.yml` | Public registry; no account needed |
| 6 | **Rust / crates.io** | Builds the native DWG writer (`cad-engine-rust`) to wasm32 in CI and deploy | `.github/workflows/deploy.yml`, `unit-tests.yml` (`cargo build --locked`) | Public registry; no account needed |
| 7 | **LinkedIn Developer app** — "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect" | Personal-profile publishing via the Cloudflare Worker (`/api/linkedin/connect`, `/callback`, `/publish`). OAuth tokens live in the `LINKEDIN_VAULT` Durable Object, never in the repo | `docs/LINKEDIN_PUBLISHING.md`, `worker/linkedin*`, `.github/workflows/linkedin-publish.yml` | Owner's LinkedIn account + LinkedIn developer app (Client ID/secret are Worker secrets, §3) |
| 8 | **Autodesk APS (Autodesk Platform Services)** | Optional server-side conversion of uploaded `.rvt`/`.nwd` files. **No APS credentials exist anywhere in the repo or the VM** (verified 2026-11-21); without them the server stores the file for manual conversion and sends it nowhere | `server/index.mjs:690-692` (`APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `APS_BUCKET`), `SECURITY.md` | **Unknown — owner to confirm:** whether an APS app exists at all, and who holds its credentials if it does |
| 9 | **GitHub App: meta-muse-ai (Muse)** | Contents read/write on the repo (installed 2026-11-21; used to push the four ready hardening fixes to `main`) | Maintainer record, 2026-11-21 — **not verifiable from the repo itself** | Owner installed it; owner to confirm it is still installed and scoped as intended |
| 10 | **AI providers (user-held, not project accounts)** — Anthropic, OpenAI, Gemini, LM Studio / Ollama / LAN hosts | Optional cloud-AI features in the app. Keys are entered by each user in the app and encrypted at rest (AES-256-GCM, key in IndexedDB, `src/core/secure-store.ts`). There is no shared project key | `src/features/ai-providers.ts`, `SECURITY.md` | Each user holds their own key; the project holds none |
| — | **Formerly present, now gone** | OpenCode CI workflow (`.github/workflows/opencode.yml`) — added 2026-11-03, **removed** 2026-11-21 (`f021349f`). No OpenCode secret or service remains | `git log -- .github/workflows/opencode.yml` | — |

**Not accounts (no login, no secret):** reference/validation tools used locally
— Bonsai/Blender + IfcOpenShell, Solibri/BIMcollab, BricsCAD, ezdxf — and the
jsDelivr CDN fallback, which was removed (see `test:no-cdn-imports`).

## 3. Secrets — names, locations, rotation (no values)

| Secret name | Where it lives | What it unlocks | How to rotate (procedure only) |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub repo secret (Actions). Scope per `.github/workflows/deploy.yml` header: Workers Scripts:Edit + Account Settings:Read | Deploying the Worker | Create a new token in the Cloudflare dashboard with the same scope → replace the GitHub repo secret → prove it with a manual `Deploy Worker` dispatch. Old token: revoke in the Cloudflare dashboard |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub repo secret (Actions) | Identifies the Cloudflare account for deploy | Not a credential by itself; update only if the Cloudflare account changes. Value is the account id shown in the Cloudflare dashboard |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI` | Cloudflare Worker secrets (`npx wrangler secret put <NAME>`) | LinkedIn OAuth app for the Worker | Rotate in the LinkedIn Developer Portal, then `npx wrangler secret put …` for the changed values, then `npx wrangler@4 deploy`. Never commit or paste them in issues/PRs/chat (`docs/LINKEDIN_PUBLISHING.md` §2) |
| `LINKEDIN_PUBLISH_SECRET` | **Two places, must match:** Cloudflare Worker secret *and* GitHub repo secret | Bearer credential for `POST /api/linkedin/publish` and the `linkedin-publish.yml` workflow | Generate with `openssl rand -hex 32` → set in both places → redeploy the Worker → prove with a manual `Publish LinkedIn post` dispatch |
| `LINKEDIN_WORKER_URL` | GitHub repo secret (Actions) | The Worker URL the publish workflow calls | Update only if the Worker hostname changes |
| `GITHUB_TOKEN` | Automatic, per-run (GitHub Actions) | The Windows-installer workflow uploads the `.exe` to a GitHub Release (`softprops/action-gh-release@v2`, `contents: write`) | Not stored; nothing to rotate |
| `OBS_SERVER_TOKEN` | Environment variable on whichever machine runs the collab server (never in the repo) | Bearer token for the collaboration server's `/api/` routes | Set a new long random value in the server's environment, restart the server, give the new token to every connected client. Loopback-only servers may run tokenless by design (`server/startup-config.mjs` refuses a non-loopback bind without a token) |
| `OBS_ALLOWED_ORIGINS` | Same server environment | Origin allow-list for the collab server | Edit the env value, restart the server |
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `APS_BUCKET` (default `openbimstudio-convert`) | Server environment only, read at `server/index.mjs:690-692` | Autodesk APS conversion | Rotate in the Autodesk APS dashboard → update the server env → restart. **Unknown:** whether an APS app exists — see §2 row 8 |
| AI provider keys (per user) | Each user's browser, encrypted at rest (see §2 row 10) | That user's cloud-AI calls | Rotate at the provider's dashboard, re-enter the new key in the app. On a shared computer, use Ctrl+P → **Privacy: forget saved API keys, tokens and AI approvals** (`SECURITY.md`) |
| `SHARE_SECRET` | **Does not exist on `main`.** It appears only on the unmerged share-links branch (`feat/share-live-model-link`) and must not be treated as a live secret | — | — |

**If a secret is ever pasted into a chat, an issue, or a commit:** revoke/rotate
it immediately using the row above, then check the GitHub secret-scanning /
push-protection alerts. Do not "delete the message and hope" — a leaked
long-lived token stays valid until rotated (`SECURITY.md`).

## 4. Deploy procedure

### 4.1 Live demo (Vercel) — automatic

1. Merge to `main` (see §6 — branch protection is the gate, and it is still
   open as a task; until it lands, merges rely on habit, not enforcement).
2. Vercel builds (`npm install --legacy-peer-deps`, `npm run build`, output
   `dist`) and serves `https://open-bi-mstudio.vercel.app`.
3. Confirm: open the URL, check the app boots with no console errors.
   **Unknown:** the Vercel project/dashboard location — owner to confirm (§2
   row 3). If Vercel ever stops deploying, the Cloudflare Worker (§4.2) is the
   fallback host; it serves the same `dist/`.

### 4.2 Cloudflare Worker — automatic after green CI, or manual

1. Push to `main` → CI runs → on success, `Deploy Worker` (`deploy.yml`)
   builds the Rust wasm engine, runs `npm run build`, and runs
   `wrangler deploy` (wrangler 4.153.0 pinned in the workflow) with
   `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.
2. Manual: Actions → **Deploy Worker** → Run workflow (also the way to prove
   a rotated Cloudflare token works).
3. Confirm: `https://openbimstudio.amdghedy.workers.dev/` loads; the visit
   counter (`/api/visits`) responds.
4. If deploy fails: the workflow's "Deploy failure help" step says to check
   Workers Scripts:Edit permission and `CLOUDFLARE_ACCOUNT_ID` first.

### 4.3 Windows desktop installer — on tags, or manual

1. Trigger: push a `v*` tag, a manual dispatch, or a PR touching
   `desktop/**`, `electron-builder.yml`, `package.json`, `src/**`,
   `public/**`, or `scripts/**` (`.github/workflows/windows-installer.yml`).
2. The workflow builds the app and `electron-builder` (NSIS, x64,
   `OpenBIMStudio-Setup-${version}-${arch}.exe`) and uploads the `.exe` to a
   GitHub Release (`softprops/action-gh-release@v2`,
   `generate_release_notes: true`).
3. **Unsigned:** no code-signing certificate or signing secret exists in
   `electron-builder.yml` or the workflow — the installer ships unsigned.
   That is a known property, not an oversight to fix silently; signing it is
   an owner decision (certificate purchase + secret).
4. Confirm: download the `.exe` from the Release and install it once.

### 4.4 Collaboration server — the user runs it, not the project

```bash
node server/index.mjs            # default: 127.0.0.1:4000, tokenless on loopback
HOST=0.0.0.0 OBS_SERVER_TOKEN=<long random value> \
  OBS_ALLOWED_ORIGINS=https://studio.example node server/index.mjs
```

- Never expose it beyond a trusted network without HTTPS (reverse proxy) and
  a token (`SECURITY.md`). Non-loopback bind without a strong token (≥16
  chars) and an explicit origin list makes the process exit at startup.
- Data lives in `OBS_DATA_DIR` (default `server/data/`); the server backs up
  `projects.json`/`rooms.json` before every write (newest 5, `server/backup.mjs`).
- Uploads: model/drawing types only, sanitised names, 24 h retention.

### 4.5 Cutting a release

1. Bump `"version"` in `package.json` (currently `0.74.0`).
2. In `CHANGELOG.md`: move the `## [Unreleased]` content into a dated
   `## [x.y.z] — YYYY-MM-DD` section; leave a fresh empty `## [Unreleased]`
   at the top. There must be exactly **one** Unreleased section (this file's
   history had two — fixed 2026-11-21).
3. Create an annotated tag at the release commit and push it:
   `git tag -a vX.Y.Z <commit> -m "Release vX.Y.Z: <one line>"` then
   `git push origin vX.Y.Z`. The `v*` tag triggers the Windows installer
   workflow (§4.3); the GitHub Release is created by that workflow.
4. The Vercel and Cloudflare deploys follow the `main` push, not the tag.
5. **Tag hygiene (found 2026-11-21):** `v0.74.0` is a *lightweight* tag
   pointing at `512873d` (2026-11-03, "ci: authenticate OpenCode release
   lookup") — the HEAD when the GitHub Release was cut, not the version-bump
   commit `a1ee064f` (2026-10-26). `v0.73.0` did not exist and was created
   locally by this runbook's change at the version-bump commit `7c85364b`
   (2026-10-26); it still needs pushing by the owner (see the PR description
   for the exact commands). Prefer annotated tags for future releases so the
   tag carries its own date and message.

## 5. Everyday operations

- **CI is the gate:** `unit-tests.yml` — job `Build and quality checks`
  (typecheck, build, the `ci-unit-tests.mjs` battery, golden round-trip, safe-load
  audit, no-GPL check, perf-budget gate) and job `Browser smoke (blocking,
  Chromium)`. Firefox/WebKit run nightly, advisory only
  (`cross-browser.yml`). Nightly IFC fuzz runs on `nightly-fuzz.yml` with a
  containment gate (fail if >30% parser timeouts, >35% crashes, >1% startup
  timeouts — `scripts/fuzz-ifc-corpus.mjs`).
- **Checks that must never be weakened to go green:** raising a baseline or
  weakening an assertion needs an independently justified, reviewed change
  with the remaining debt recorded (`CONTRIBUTING.md`).
- **Backups:** server backups are automatic (§4.4). Browser projects: keep a
  password-protected `.obsproj` backup of anything important; a forgotten
  project password cannot be recovered (`SECURITY.md`).
- **Vulnerability reports:** ask the reporter to open a *private* security
  advisory on the repo, not a public issue (`SECURITY.md`).
- **Where decisions live:** `docs/engineering/decisions/` — read the note
  before re-litigating a P0 call.

## 6. Branch protection — the one setting this runbook assumes, and its status

As of 2026-11-21, issue **#142 is still OPEN** (verified against the live
tracker). Branch protection on `main` is a GitHub Settings state: no file in
the repo can enforce it or prove it. The check is:

```bash
gh api repos/amdghedy/openBIMstudio/branches/main/protection
```

or Settings → Branches → the `main` rule. The rule #142 asks for — require a
PR, require the two real CI checks, require up-to-date branches, restrict force
pushes/deletions — is the precondition for everything else in this runbook:
without it, a direct push can bypass CI and ship to the live demo. **Do not
use #142's check names verbatim** — "Unit tests", "golden-roundtrip" and
"native-bim-validation" do not exist as CI job names; the real jobs are
`Build and quality checks` and `Browser smoke (blocking, Chromium)`. Until the
rule exists, treat every merge to `main` as ungated and verify CI green by hand
before and after.

## 7. If the maintainer is unreachable

This is the honest version: there is no co-maintainer, no shared account
access, and no sealed copy yet (see §8). What a successor *can* and *cannot*
do follows from that.

**A successor can, with only this repo (it is public):**

1. Fork `amdghedy/openBIMstudio` and keep developing under the fork.
2. Run the app locally: `npm install` (Node 22), `npm run dev`
   (`http://localhost:3000`); run the checks in `CONTRIBUTING.md`.
3. Deploy a working copy under their own accounts: the Vercel config
   (`vercel.json`) and the Cloudflare config (`wrangler.jsonc`, Worker
   `openbimstudio`) are in the repo, so `npm run build && wrangler deploy`
   on their own Cloudflare account, or a fresh Vercel project import,
   produces a live app at a new URL.
4. Run the collaboration server on loopback with no secrets (§4.4).
5. Cut releases from the fork (version bump + CHANGELOG + tag, §4.5).

**A successor cannot, without the owner or the sealed copy (§8):**

- Push to `amdghedy/openBIMstudio`, merge PRs, or change its Settings
  (branch protection, secrets, GitHub App installs).
- Deploy to `open-bi-mstudio.vercel.app` or
  `openbimstudio.amdghedy.workers.dev`, or rotate `CLOUDFLARE_API_TOKEN`,
  the LinkedIn Worker secrets, or the GitHub repo secrets.
- Reconnect the LinkedIn integration (needs the LinkedIn developer app +
  the Worker's `LINKEDIN_CLIENT_*` secrets) or use the existing APS
  credentials, if any exist.
- Recover user data: projects live in users' browsers / `.obsproj` files /
  their own servers. There is no central user database to hand over.

**First 48 hours for a successor:** fork the repo; confirm the fork's CI is
green; deploy the fork to a new Cloudflare/Vercel URL and announce it as the
continuation; open an issue in the fork stating the maintainer is unreachable
and inviting a co-maintainer. Do not claim the original domains or accounts.

## 8. OPEN — the sealed copy (a user-side step, not done from here)

The runbook in the repo is only half the resilience story. The other half is
a **sealed copy held by a trusted person** (or in the owner's password manager
/ will / estate papers), and it does not exist yet as far as this repo can
show. The owner needs to:

1. Pick one trusted person and tell them where the sealed copy is.
2. Put in it: GitHub account recovery details; Cloudflare login + API token
   scope; Vercel account/project; LinkedIn developer app access; the APS app
   credentials if they exist; the Muse GitHub App install state; and a copy
   of this runbook (or its location in the repo).
3. Include the rotation procedures in §3, not the values in plain text where
   avoidable — a password manager entry per service, with this runbook as the
   index, is the intended shape.
4. Re-check it yearly: log in to each account, confirm the sealed copy still
   opens, and confirm the recovery email/phone on each account is current.

Until that is done, §7's "cannot" list is the true state, and this item stays
**OPEN**.

## 9. OPEN — one external eye (not done from here)

No external reviewer or tester exists for this project (bus factor 1, verified
2026-11-20 and re-checked 2026-11-21: every commit, issue, and human PR traces
to one human, amdghedy — 358 of the 1,472 commits are authored under the
`Claude <noreply@anthropic.com>` agent identity, and the rest of the
non-human commits are bots; 9 stars / 1 fork as of the 2026-11-20 dive, no
external contributor ever). Getting one is a months-long social
outcome, not a task completable from this repo. What is needed, concretely:

- **Option A (preferred):** one external reviewer for P0/security PRs — a
  person with BIM or TypeScript security experience willing to review a
  focused PR before merge. Ask in the repo (pinned issue), in the BIM
  community channels the maintainer already uses, or among the project's
  stargazers.
- **Option B:** one external tester running the app against a real project
  file (IFC/DWG) and reporting what breaks, with the file shared under a
  clear licence for regression fixtures.
- Either way, the ask must name the time commitment (one PR review, or one
  test session) and the channel (GitHub PR review / issue). Until someone
  says yes, this stays **OPEN**, and the runbook + decision notes are what
  make the project *ready* for that person rather than blocked waiting for
  them.

## 10. What this runbook does not cover (known unknowns)

- Vercel project/account identity (§2 row 3) — owner to confirm.
- Whether an Autodesk APS app exists, and who holds its credentials (§2
  row 8) — owner to confirm.
- Whether the meta-muse-ai GitHub App is still installed and scoped as
  intended (§2 row 9) — owner to confirm.
- The sealed copy (§8) and the external eye (§9) — both OPEN, both need the
  owner, neither can be done from this repo.
