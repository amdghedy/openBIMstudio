// Static drift guard: features added in this work stay reachable from the UI.
// Not a browser test: it proves wiring exists in source (button -> handler -> command), not that it renders.
const fs = require("fs");
const read = (p) => fs.readFileSync(p, "utf8");
const cad = read("src/features/cad-viewer.ts"), ai = read("src/features/ai-chat.ts"), presets = read("src/features/ai-presets.ts"),
  prov = read("src/features/ai-providers.ts"), clash = read("src/features/clash.ts"), html = read("index.html"),
  plan = read("src/features/plan-view-panel.ts"), ribbon = read("src/shell/ribbon.ts"), bimx = read("src/features/bim-experience.ts");
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log("  PASS", n); } catch (e) { fail++; console.log("  FAIL", n + ": " + e.message); } };
const must = (c, m) => { if (!c) throw new Error(m); };

t("CAD Insert tab: every new button has a ribbon entry AND a handler", () => {
  for (const id of ["blk-make", "blk-insert", "blk-file", "blk-write", "blk-lib", "blk-explode", "svg-import", "ins-field", "ins-table"]) {
    must(cad.includes(`data-a="${id}"`), `${id}: no ribbon button`);
    must(new RegExp(`"${id}":\\s*\\(`).test(cad), `${id}: no handler in the action map`);
  }
});
t("CAD Insert tab: hidden file inputs exist and have onchange handlers", () => {
  for (const r of ["blockfile", "svgfile", "importfile"]) {
    must(cad.includes(`data-r="${r}"`), `${r}: input missing`);
  }
  must(/blockIn\.onchange/.test(cad) && /svgIn\.onchange/.test(cad), "file input handlers missing");
});
t("CAD commands typed in the command line: listed, completable and dispatched", () => {
  for (const c of ["BLOCK", "INSERT", "WBLOCK", "BLOCKLIB", "SVGIMPORT", "FIELD", "IMPORT", "DWGVERSION"]) {
    must(new RegExp(`name: "${c}"`).test(cad), `${c}: not in the command table`);
    must(new RegExp(`cmd === "${c}"`).test(cad), `${c}: no dispatch`);
  }
  must(!/name: "IMPORT", aliases: \[[^\]]*"INSERT"/.test(cad), "INSERT alias must belong to the block command");
});
t("CAD Insert tab groups are tagged to the insert tab", () => {
  for (const g of ["Block", "Import", "Fields"]) {
    must(new RegExp(`rg\\(\\s*"${g}"[\\s\\S]*?"insert",\\s*\\)`).test(cad), `group ${g} not on insert tab`);
  }
});
t("Placement session shows a command label for INSERT / SVGIMPORT / FIELD", () => {
  must(/beginPlacement\([^)]*"INSERT"\)/.test(cad) && /"SVGIMPORT"\)/.test(cad) && /"FIELD"\)/.test(cad), "placement labels missing");
});
t("AI: Claude appears in the provider dropdown, presets, dispatch and CSP", () => {
  must(ai.includes('value="anthropic"'), "dropdown option missing");
  must(/kind: "anthropic"/.test(presets), "Claude presets missing");
  must(/callAnthropic\(cfg, req\)/.test(prov) && /callAnthropicStream\(cfg, req, onToken\)/.test(prov), "dispatch missing");
  must(html.includes("https://api.anthropic.com"), "CSP missing api.anthropic.com");
  must(ai.includes("Claude with your own account"), "key guidance tip missing");
});
t("AI: extra provider presets are used by the settings pane", () => {
  must(/PRESETS/.test(ai) && /from "\.\/ai-presets"/.test(ai), "ai-chat does not use ai-presets");
  for (const n of ["xAI", "Fireworks", "SambaNova", "NVIDIA NIM", "Hyperbolic", "Moonshot", "Qwen", "llama.cpp", "vLLM", "Jan"]) must(presets.includes(n), `${n} preset missing`);
});
t("Clash: native elements in the A/B tree, category dialog API, coverage line", () => {
  must(/ids\.push\(AUTHORED_MODEL_ID\)/.test(clash), "native elements not offered in the selection tree");
  must(/setSelectionA,\s*\n\s*setSelectionB,/.test(clash), "setSelectionA/B not on the clash service");
  must(/coverageSummary\(getLastCollectionReport\(\)\)/.test(clash), "coverage line not shown");
  must(/planScope\(/.test(clash), "run does not use the scope plan");
  must(/obs:authoring-changed/.test(clash), "native elements do not refresh in the tree as you model");
});
t("Earlier features stay reachable: plan command line, DWG version, place options, reveal, clash dock", () => {
  must(/ensurePlanCommandLine\(\)\.el/.test(plan), "plan command line not mounted");
  must(/PLACE_TOOLS/.test(ribbon) && /buildPlaceOptions/.test(bimx), "door/window place options not wired");
  must(read("src/shell/ribbon.ts").includes('"Reveal"'), "Reveal button missing");
  must(/makeDockable/.test(read("src/features/clash-review.ts")), "clash review dock missing");
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
