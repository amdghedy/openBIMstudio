#!/usr/bin/env bash
# Creates the 18 hardening issues from ISSUES.md via the REST API (no gh CLI
# needed), closes the ones already satisfied on main with evidence comments,
# and drops progress comments on the partial ones. Idempotent: an issue whose
# title already exists (open or closed) is skipped, so re-running only catches
# up comments. Auth: GH_TOKEN env var or /tmp/gh.token.
set -u
REPO="amdghedy/openBIMstudio"
DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN="${GH_TOKEN:-$(cat /tmp/gh.token 2>/dev/null)}"
[ -n "$TOKEN" ] || { echo "no token: set GH_TOKEN or create /tmp/gh.token" >&2; exit 1; }
API="https://api.github.com"
H=(-H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json")

api() { curl -sS "${H[@]}" "$@"; }

ensure_label() { # name color description
  api -o /dev/null -X POST "$API/repos/$REPO/labels" \
    -d "{\"name\":\"$1\",\"color\":\"$2\",\"description\":\"$3\"}" || true
}
for spec in "hardening:0e8a16:Production hardening plan" \
            "P0:b60205:Priority 0" "P1:d93f0b:Priority 1" "P2:fbca04:Priority 2" \
            "critical:b60205:" "high:d93f0b:" "medium:fbca04:"; do
  IFS=: read -r n c d <<<"$spec"
  ensure_label "$n" "$c" "$d"
done

issue_number() { # exact title -> number or empty
  api "$API/search/issues?q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote('repo:$REPO in:title \"\"'+sys.argv[1]+'\"'))" "$1")%20type:issue" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);i=d.get('items',[]);print(i[0]['number'] if i else '')" 2>/dev/null
}

comment() { api -X POST "$API/repos/$REPO/issues/$1/comments" -d "{\"body\":$2}" >/dev/null; }
close()   { api -X PATCH  "$API/repos/$REPO/issues/$1" -d '{"state":"closed"}' >/dev/null; }

python3 - "$DIR/ISSUES.md" <<'PY' > /tmp/issues-bodies.tsv
import re, sys, json
md = open(sys.argv[1]).read()
# table rows: id | title | priority | phase | estimate | status
rows = re.findall(r'^\| (P\d-\d\d) \| (.*?) \| (.*?) \| (.*?) \| .*? \|', md, re.M)
# section bodies between "## P0-01 ..." and the next "## " / "---"
for pid, title, prio, phase in rows:
    m = re.search(rf'^## {pid} — (.*?)$\n(.*?)(?=^## P\d|^## Status|\Z)', md, re.M | re.S)
    body = (m.group(2) if m else '').strip()
    print(json.dumps([pid, title.strip(), prio.strip(), phase.strip(), body]))
PY

# per-issue metadata: satisfied -> close with evidence; partial -> progress comment
declare -A LABELS EXTRA
for id in P0-01 P0-02 P0-03 P0-04 P0-05 P1-01 P1-02 P1-03 P1-04 P1-05 P1-06 P1-07 P2-01 P2-02 P2-03 P2-04 P2-05 P2-06; do
  LABELS[$id]="${id%%-*}"
done
SATISFIED=$(cat <<'EOF'
P0-01|All four deliverables are on main: `src/core/crashLog.ts` (capped ring buffer + `exportCrashReport`), the `AppErrorBoundary` component, `window.onerror`/`unhandledrejection` handlers wired before feature modules load, and a crash-log viewer reachable from the shell UI. Evidence: `scripts/check-hardening-evidence.sh` on `7b7a338`.
P0-05|`jsonpath-plus` is no longer in `package.json`, and an npm-audit CI gate is present in the workflows. Evidence: `scripts/check-hardening-evidence.sh` on `7b7a338`.
P1-01|`src/core/registry.ts` (typed service registry) and an ESLint rule covering `__obs*` globals are both on main. Evidence: `scripts/check-hardening-evidence.sh` on `7b7a338`.
P1-02|`tsconfig.json` has `\"strict\": true`; src/modules and src/core compile under it (CI green). Evidence: `scripts/check-hardening-evidence.sh` on `7b7a338`.
P1-04|`scripts/golden-roundtrip.mjs` is self-contained and `.github/workflows/golden-roundtrip.yml` runs on push/pull_request (`on: [push, pull_request, workflow_dispatch]`, aligned install pattern, green on main). Evidence: `scripts/check-hardening-evidence.sh` on `7b7a338`.
P2-05|`SPEC_TEMPLATE.md` exists in the repo. Evidence: `scripts/check-hardening-evidence.sh` on `7b7a338`.
EOF
)
PARTIAL=$(cat <<'EOF'
P0-02|Progress on main: `src/core/safeLoad.ts` + `ProjectFileSchema`/`BcfManifestSchema` exist. Still missing: routing all JSON loaders through `safeLoad`, the 10-input malformed corpus under `tests/fixtures/malformed/`, and the CI grep audit.
P0-04|Progress on main: `api/` server with origin allow-list is in place. Still missing: rate limiting.
P1-03|Progress on main: `test/fixtures/ifc-corpus/snapshots/` exists with 3 fixtures (IfcOpenHouse_IFC4, example, test). Still missing: 17 more licensed fixtures to reach 20.
P1-06|Progress on main: malformed/truncation handling tests exist in `tests/` (project-file, server-hardening). Still missing: property-based rejection suites for IFC/BCF/DXF.
P1-07|Progress on main: `playwright.config.ts` exists. Still missing: `@playwright/test` in devDependencies and the multi-browser smoke suite.
P2-01|Progress on main: `src/core/journal.ts` (append-only journal) exists. Still missing: wiring into the persistence layer + snapshot recovery.
P2-02|Progress on main: `scripts/check-tool-catalog.mjs` exists. Still missing: enforcing it as a CI gate.
P2-03|Progress on main: `scripts/budget.json` exists. Still missing: the benchmark + CI workflow enforcing it.
EOF
)

while IFS= read -r line; do
  IFS=$'\t' read -r pid title prio phase body <<<"$(python3 -c "import json,sys;a=json.loads(sys.argv[1]);print('\t'.join(a))" "$line")"
  num="$(issue_number "$title")"
  labels="hardening,${LABELS[$pid]}"
  if [ -z "$num" ]; then
    payload=$(python3 -c "import json,sys;print(json.dumps({'title':sys.argv[1],'body':sys.argv[2],'labels':sys.argv[3].split(',')}))" "$title" "$body" "$labels")
    num="$(api -X POST "$API/repos/$REPO/issues" -d "$payload" | python3 -c "import json,sys;print(json.load(sys.stdin).get('number',''))")"
    echo "created #$num $pid"
  else
    echo "exists  #$num $pid"
  fi
  [ -n "$num" ] || continue
  ev="$(printf '%s\n' "$SATISFIED" | grep "^$pid|" | cut -d'|' -f2-)"
  pg="$(printf '%s\n' "$PARTIAL" | grep "^$pid|" | cut -d'|' -f2-)"
  if [ -n "$ev" ]; then
    close "$num"; comment "$num" "$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "**Closing automatically:** $ev")"
    echo "  closed as satisfied"
  elif [ -n "$pg" ]; then
    comment "$num" "$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$pg")"
    echo "  progress comment added"
  fi
done < /tmp/issues-bodies.tsv
echo done
