// AI copilot docked inside the 2D CAD engine — source drift-guard test.
//
// The AI agent engine (ai-chat/ai-providers/ai-tools) was built for the 3D
// BIM workspace. This suite guards the integration that docks the SAME
// engine inside the 2D CAD shell:
//
//   1. cad-viewer.ts opens/copilots: Quick Access "ai" button, ribbon
//      "AI Copilot" group, host switch on open, release on hideShell.
//   2. ai-chat.ts host switching: openAiChatInHost / isAiChatCadHosted /
//      releaseAiChatToDefaultHost / askAiChat, plus the CAD drafting
//      addendum appended to the system prompt while docked.
//   3. ai-tools.ts: get_cad_state (read-only) and run_cad_command
//      (write → approval) wired into TOOLS + executeTool, with the
//      cad-viewer bridge exports runCadAiCommand / getCadAiState.
const fs = require("fs"), path = require("path"), assert = require("assert");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "src", ...p), "utf8");
const viewer = read("features", "cad-viewer.ts");
const chat = read("features", "ai-chat.ts");
const tools = read("features", "ai-tools.ts");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const ciList = fs.readFileSync(path.join(__dirname, "..", "scripts", "ci-unit-tests.mjs"), "utf8");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// ── 1. cad-viewer: the AI copilot is reachable from the 2D shell ──
t("cad-viewer: QAT + ribbon AI buttons wired to toggleCadAi", () => {
  assert.ok(viewer.includes('qatBtn("generative", "ai"'), "Quick Access AI button missing");
  assert.ok(viewer.includes('else if (a === "ai") toggleCadAi();'), "QAT dispatch for the ai action missing");
  assert.ok(viewer.includes('"AI Copilot"'), "ribbon AI Copilot group label missing");
  assert.ok(viewer.includes('data-a="aicopilot"'), "ribbon AI Copilot button missing");
  assert.ok(viewer.includes('data-a="aicopilot-info"'), "ribbon AI Drawing Info button missing");
  assert.ok(viewer.includes("aicopilot: () => toggleCadAi()"), "act map entry for aicopilot missing");
  assert.ok(viewer.includes('"aicopilot-info": () =>'), "act map entry for aicopilot-info missing");
  assert.ok(viewer.includes("askCadAi("), "askCadAi helper missing");
});

t("cad-viewer: host switch open + release on shell close", () => {
  assert.ok(viewer.includes('openAiChatInHost(shell, { storageId: "ai-chat-cad" })'), "openAiChatInHost(shell) call missing");
  assert.ok(
    /function hideShell\(\): void \{[\s\S]*?releaseAiChatToDefaultHost\(\);[\s\S]*?\}/.test(viewer),
    "hideShell must release the AI panel back to the BIM workspace",
  );
  assert.ok(viewer.includes('from "./ai-chat"'), "ai-chat import missing");
});

t("cad-viewer: engine bridge exports for the AI tools", () => {
  assert.ok(viewer.includes("export function getCadAiState("), "getCadAiState export missing");
  assert.ok(viewer.includes("export function runCadAiCommand("), "runCadAiCommand export missing");
  assert.ok(viewer.includes("runCommandText(text: string): void;"), "CadEngineApi.runCommandText missing");
  assert.ok(viewer.includes("aiSnapshot(): { tool: string; entityCount: number }"), "CadEngineApi.aiSnapshot missing");
  assert.ok(viewer.includes("runCommandText: (text: string) => {"), "engine runCommandText impl missing");
  assert.ok(viewer.includes("aiSnapshot: () => ({ tool: String(tool), entityCount: ents.length })"), "engine aiSnapshot impl missing");
});

// ── 2. ai-chat: same engine, docked host ──
t("ai-chat: host switching API exported", () => {
  assert.ok(chat.includes("export function openAiChatInHost("), "openAiChatInHost missing");
  assert.ok(chat.includes("export function isAiChatCadHosted("), "isAiChatCadHosted missing");
  assert.ok(chat.includes("export function releaseAiChatToDefaultHost("), "releaseAiChatToDefaultHost missing");
  assert.ok(chat.includes("export function askAiChat("), "askAiChat missing");
  assert.ok(chat.includes('dock = mountDock(ctx.rightHost, "ai-chat");'), "setupAiChat must mount through mountDock");
  assert.ok(chat.includes("try { dock?.dispose(); } catch { /* */ }"), "mountDock must dispose the previous dock handle");
});

t("ai-chat: drawing-mode addendum appended while docked", () => {
  assert.ok(chat.includes("const CAD_AI_ADDENDUM"), "CAD_AI_ADDENDUM missing");
  assert.ok(chat.includes("## 2D drawing mode"), "addendum heading missing");
  assert.ok(chat.includes("Call get_cad_state first"), "addendum must teach get_cad_state");
  assert.ok(chat.includes("run_cad_command"), "addendum must teach run_cad_command");
  assert.ok(
    chat.includes('content: cadHosted ? SYSTEM_PROMPT + CAD_AI_ADDENDUM : SYSTEM_PROMPT'),
    "runAgentLoop must switch the system prompt by host",
  );
});

// ── 3. ai-tools: 2D CAD tools registered + gated ──
t("ai-tools: get_cad_state + run_cad_command registered", () => {
  assert.ok(tools.includes('name: "get_cad_state"'), "get_cad_state tool missing");
  assert.ok(tools.includes('name: "run_cad_command"'), "run_cad_command tool missing");
  assert.ok(tools.includes('"run_cad_command",') , "run_cad_command must be in WRITE_TOOLS (approval)");
  assert.ok(!/DESTRUCTIVE_TOOLS = new Set\(\[[\s\S]*?"run_cad_command"/.test(tools), "run_cad_command must not be destructive");
  assert.ok(tools.includes('case "get_cad_state": return await getCadStateTool();'), "executeTool case for get_cad_state missing");
  assert.ok(tools.includes('case "run_cad_command": return await runCadCommandTool(call.args);'), "executeTool case for run_cad_command missing");
  assert.ok(tools.includes('await import("./cad-viewer")'), "CAD bridge must be a dynamic import (no boot-time cycle)");
});

// ── 4. CI registration ──
t("CI: test registered in package.json + ci-unit-tests.mjs", () => {
  assert.ok(pkg.scripts["test:cad-ai"], "package.json test:cad-ai script missing");
  assert.ok(pkg.scripts["test:cad-ai"].endsWith("tests/cad-ai-integration.test.cjs"), "test:cad-ai points at the wrong file");
  assert.ok(ciList.includes('"test:cad-ai"'), "ci-unit-tests.mjs list missing test:cad-ai");
});

console.log(`\ncad-ai-integration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
