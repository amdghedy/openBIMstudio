# CI fix notes (2026-10-25)

## Root cause of Action failures

`package.json` had mixed React versions:

- `react`: ^18.3.1
- `react-dom`: ^19.3.1
- `@types/react`: ^18.3.0
- `@types/react-dom`: ^19.3.0

That breaks `npm run typecheck` and unit-test workflows.

## Fixed on main

- `package.json` aligned all four packages to **React 18.3.x**.

## Still required locally / in CI lockfile

If `npm ci` still installs `react-dom@19`, regenerate the lockfile:

```bash
npm install react@18.3.1 react-dom@18.3.1 @types/react@18.3.12 @types/react-dom@18.3.1
npm ci
npm run typecheck
```

Then commit `package-lock.json`.

## Dependabot PRs #53–#57

These are **major** bumps (React 19, R3F 9, MUI lab dev, etc.) and will keep failing CI until a dedicated migration is done. Close or leave open with REQUEST_CHANGES; do not merge into main.

## Permanent test-flag fix (2026-10-26)

**Root cause of the remaining Unit tests failures** — two invalid `tsc` flags
embedded in the per-file test harnesses:

- `--ignoreConfig` — never a real TypeScript option (TS5023)
- `--ignoreDeprecations 6.0` — rejected by the installed TypeScript 5.6 (TS5103)

CI had been working around this with a `sed` patch step in `unit-tests.yml`.
The flags are now removed **at the source** in all `tests/*.cjs` files, so the
tests run as-committed everywhere (local, CI, any machine). The `sed` step
stays in the workflow as a harmless safety net.

**Root cause of the three genuinely failing suites** — the test specs define
the intended public API, but the modules had been renamed without updating
the specs:

| Test spec | Expected export | Fix |
|-----------|-----------------|-----|
| `tests/safe-expr.test.cjs` | `safeEval(src, scope?, fns?)` → value or `null` | Added `safeEval` wrapper in `src/modules/families/safe-expr.ts` |
| `tests/secret-crypto.test.cjs` | `encryptSecret` | Added stable alias of `encryptString` in `src/core/secret-crypto.ts` |
| `tests/ai-privacy.test.cjs` | `redactForCloud(text)` | Implemented full credential scrubber in `src/features/ai-privacy.ts` (see below) |

The `ai-privacy` spec was additionally extended from 1 stub assertion to 15
assertions covering GitHub/OpenAI/AWS/Google/Slack/Groq/HF keys, JWT, Bearer,
PEM private keys, URL passwords and — importantly — false-positive checks
("tokens used: 512" must stay untouched).

## AI credential redaction (2026-10-26)

`src/features/ai-providers.ts` now scrubs every outgoing request through
`redactForCloud` / `redactJsonStringsForCloud` **only when the endpoint is not
private** (local Ollama / LM Studio / LAN endpoints are untouched, since data
never leaves the machine there). Scrubbing covers all conversation turns and
tool-call arguments, is failure-safe (never blocks chat), and surfaces a
single quiet status toast when credentials were found and replaced with
`[redacted]`.
