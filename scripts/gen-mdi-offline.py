#!/usr/bin/env python3
"""Generate the offline mdi icon subset for the CSP-safe icon loader.

The @thatopen vendor UI and our own shell render <iconify-icon> elements.
Without a local collection the runtime fetches icons from api.iconify.design
(and its mirrors) — blocked by CSP in production and a hole in the
no-third-party-runtime-dependency story (see feature-maturity pwa-offline).
This script writes only the icons actually used anywhere in the app or the
vendor dists into src/features/mdi-offline-icons.json; the boot module
registers it via iconify-icon's addCollection so no runtime fetch happens.
"""
import json
import re
import glob

src = json.load(open("node_modules/@iconify-json/mdi/icons.json", encoding="utf-8"))

used = set()
for pat in ("src/**/*.ts", "src/**/*.html", "public/js/**/*.js",
            "node_modules/@thatopen/ui/dist/index.js",
            "node_modules/@thatopen/ui-obc/dist/index.js",
            "node_modules/@thatopen/components-front/dist/index.js"):
    for f in glob.glob(pat, recursive=True):
        try:
            text = open(f, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        used.update(re.findall(r"mdi:([a-z0-9\-]+)", text))

missing = sorted(n for n in used if n not in src["icons"])
assert not missing, f"icons not in @iconify-json/mdi: {missing}"

out = {
    "prefix": "mdi",
    "width": src.get("width", 24),
    "height": src.get("height", 24),
    "icons": {n: src["icons"][n] for n in sorted(used)},
}
# carry over any alias entries the used icons resolve to
for n in list(out["icons"]):
    alias_src = src.get("aliases", {}).get(n)
    if alias_src:
        out.setdefault("aliases", {})[n] = alias_src

json.dump(out, open("src/features/mdi-offline-icons.json", "w", encoding="utf-8"), indent=1)
open("src/features/mdi-offline-icons.json", "a", encoding="utf-8").write("\n")
print(f"offline mdi collection: {len(out['icons'])} icons → src/features/mdi-offline-icons.json")
print(" ".join(sorted(used)))
