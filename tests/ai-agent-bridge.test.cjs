/*
 * AI Agent Bridge — wiring tests.
 * Guards every channel that lets external AI clients (AlphaCLI / AlphaCode,
 * embedded parents, console automation) execute orders in the engines:
 *   window API · postMessage · URL deep links · local server relay ·
 *   cad-viewer routing (runCadAiCommand / ai-chat askAiChat) · ribbon + AGENT
 *   command · server /api/agent/* endpoints · boot registration.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

const bridge = read("src", "features", "agent-bridge.ts");
const viewer = read("src", "features", "cad-viewer.ts");
const main = read("src", "main.ts");
const server = read("server", "index.mjs");
const pkg = JSON.parse(read("package.json"));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + ": " + e.message);
  }
};

console.log("ai-agent-bridge");

t("bridge module: window API __obsAgentBridge exposes the full agent surface", () => {
  assert.ok(bridge.includes("(window as any).__obsAgentBridge = {"), "window API object missing");
  for (const member of ["exec:", "ask:", "state:", "commands:", "log:", "on:", "openPanel:", "connectRelay:", "disconnectRelay:", "relayStatus:"]) {
    assert.ok(bridge.includes(member), `window API member ${member} missing`);
  }
  assert.ok(bridge.includes("export function setupAgentBridge(): void"), "setupAgentBridge export missing");
});

t("exec orders funnel through the engine's own command dispatcher (runCadAiCommand)", () => {
  assert.ok(bridge.includes('await import("./cad-viewer")'), "lazy cad-viewer import missing");
  assert.ok(bridge.includes("viewer.runCadAiCommand(cmd)"), "orders must run through runCadAiCommand");
  assert.ok(bridge.includes("viewer.getCadAiState()"), "engine state snapshot missing");
  // Auto-open retry: a closed editor is booted once and the order retried.
  assert.ok(bridge.includes("viewer.openCadViewer()"), "auto-open of the drawing editor missing");
  assert.ok(/not open/i.test(bridge), "closed-editor retry condition missing");
});

t("ask orders funnel through the AI copilot (askAiChat), not around it", () => {
  assert.ok(bridge.includes('await import("./ai-chat")'), "lazy ai-chat import missing");
  assert.ok(bridge.includes("chat.askAiChat(q)"), "askAiChat routing missing");
  assert.ok(bridge.includes("chat.openAiChat()"), "copilot auto-open missing");
});

t("postMessage channel: __obsAgent flag, typed orders, origin allow-list", () => {
  assert.ok(bridge.includes('data.__obsAgent !== true'), "protocol flag check missing");
  for (const type of ['type === "exec"', 'type === "ask"', 'type === "state"', 'type === "commands"']) {
    assert.ok(bridge.includes(type), `postMessage type ${type} not handled`);
  }
  assert.ok(bridge.includes("export function originAllowed("), "originAllowed export missing");
  assert.ok(bridge.includes('o === window.location.origin'), "same-origin must always be allowed");
  assert.ok(bridge.includes("https://alphacli.github.io"), "the owner's platform client must be in the default allow-list");
  assert.ok(bridge.includes("obs.agent.allowedOrigins"), "runtime extra-origins key missing");
  // Rejected origins must never get a success reply.
  assert.ok(bridge.includes('reply({ ok: false, error: "Origin not allowed by the openBIMstudio Agent Bridge." })'), "reject reply missing");
});

t("deep link channel: #agent-cmd and #agent-ask parse + one-shot handling", () => {
  assert.ok(bridge.includes("export function parseAgentDeepLink("), "parseAgentDeepLink export missing");
  assert.ok(bridge.includes('/^#agent-(cmd|ask)=(.*)$/'), "deep-link regex missing");
  assert.ok(bridge.includes("window.addEventListener(\"hashchange\", handleDeepLink)"), "hashchange handling missing");
  assert.ok(bridge.includes("deepLinkHandled"), "one-shot guard missing");
});

t("local relay client: opt-in flag, SSE subscribe, result POST-back", () => {
  assert.ok(bridge.includes('localStorage.setItem(RELAY_FLAG_KEY, "1")'), "relay must be explicit opt-in");
  assert.ok(bridge.includes('localStorage.getItem(RELAY_FLAG_KEY) === "1"'), "flag read missing");
  assert.ok(bridge.includes("new EventSource(url)"), "SSE subscription missing");
  assert.ok(bridge.includes('/agent/events'), "agent events endpoint missing");
  assert.ok(bridge.includes('`${base}/agent/result`'), "result POST-back missing");
  assert.ok(bridge.includes('"agent-order"'), "order event listener missing");
  assert.ok(bridge.includes("Authorization: `Bearer ${token}`"), "relay result POST must carry the auth token");
  assert.ok(bridge.includes("__OPENBIM_COLLAB_API__"), "collab API base override missing");
});

t("every order lands in the audited bridge log with source + result", () => {
  for (const source of ['"api"', '"postmessage"', '"deeplink"', '"relay"', '"panel"']) {
    assert.ok(bridge.includes(source), `source tag ${source} not used`);
  }
  assert.ok(bridge.includes("pushLog("), "log funnel missing");
  assert.ok(bridge.includes("LOG_LIMIT"), "log ring buffer missing");
  assert.ok(bridge.includes("export function parseAgentDeepLink"), "sanity");
  assert.ok(bridge.includes("export type AgentListener"), "listener type missing");
});

t("cad-viewer: catalog export + AGENT command wired end-to-end", () => {
  assert.ok(viewer.includes("export function getCadCommandCatalog()"), "getCadCommandCatalog export missing");
  assert.ok(viewer.includes('{ name: "AGENT", aliases: ["AGENTBRIDGE", "BRIDGE", "ALPHACLI", "ALPHACODE"]'), "AGENT catalog entry missing");
  assert.ok(viewer.includes('if (cmd === "AGENT" || cmd === "AGENTBRIDGE" || cmd === "BRIDGE" || cmd === "ALPHACLI" || cmd === "ALPHACODE")'), "AGENT dispatcher arm missing");
  assert.ok(viewer.includes('data-a="agent-bridge"'), "ribbon button missing");
  assert.ok(viewer.includes('"agent-bridge": () =>'), "act handler missing");
  assert.ok(viewer.includes('import("../features/agent-bridge").then((m) => m.openAgentPanel())'), "openAgentPanel routing missing");
});

t("server relay: exec / result / status / events endpoints with hardening", () => {
  assert.ok(server.includes('url.pathname === "/api/agent/exec"'), "agent exec endpoint missing");
  assert.ok(server.includes('url.pathname === "/api/agent/result"'), "agent result endpoint missing");
  assert.ok(server.includes('url.pathname === "/api/agent/status"'), "agent status endpoint missing");
  assert.ok(server.includes('url.pathname === "/api/agent/events"'), "agent events endpoint missing");
  assert.ok(server.includes("broadcastAgent(\"agent-order\""), "order broadcast missing");
  assert.ok(server.includes("AGENT_ORDER_TIMEOUT_MS"), "pending-order timeout missing");
  assert.ok(server.includes("No openBIMstudio session is connected to the relay"), "no-studio 503 guard missing");
  assert.ok(server.includes("mutationRate.check(`agent-exec|${key}`)"), "exec rate budget missing");
  // Auth: agent SSE accepts Bearer or ?token= (EventSource cannot set headers);
  // result/exec stay Bearer-only through the generic /api/ gate.
  assert.ok(server.includes("const isAgentEvents = url.pathname === \"/api/agent/events\";"), "agent events auth branch missing");
  assert.ok(server.includes("authed = tokenOk(req.headers.authorization, url.searchParams.get(\"token\"), AUTH_TOKEN);"), "agent SSE token policy missing");
  // Orders are size-capped before reaching the browser.
  assert.ok(server.includes("slice(0, 4000)"), "order size cap missing");
});

t("boot: setupAgentBridge registered in main.ts after the AI chat", () => {
  const idx = main.indexOf('await step("ai-chat"');
  const idxBridge = main.indexOf('await step("agent-bridge"');
  assert.ok(idxBridge > -1, "agent-bridge boot step missing");
  assert.ok(idx > -1 && idxBridge > idx, "agent-bridge must boot after ai-chat");
  assert.ok(main.includes('m.setupAgentBridge()'), "setup call missing");
});

t("package.json: test:ai-agent script registered", () => {
  assert.strictEqual(pkg.scripts["test:ai-agent"], "node tests/ai-agent-bridge.test.cjs");
});

t("panel UI: status grid, try-it box, copy-snippet, relay toggle, log", () => {
  for (const marker of ["AI Agent Bridge", 'data-ab="copy"', 'data-ab="relaytoggle"', 'data-ab="run"', 'data-ab="ask"', 'data-ab="log"', "Open AI Copilot"]) {
    assert.ok(bridge.includes(marker), `panel marker ${marker} missing`);
  }
  assert.ok(bridge.includes("navigator.clipboard?.writeText(SNIPPET)"), "snippet copy missing");
  assert.ok(bridge.includes("curl -s -X POST http://localhost:4000/api/agent/exec"), "relay curl example in snippet missing");
});

t("privacy: bridge is local-first — no cloud calls, relay off by default", () => {
  assert.ok(!/fetch\("https?:\/\/(?!localhost|\$\{base\})/.test(bridge), "bridge must not call hardcoded remote hosts");
  assert.ok(bridge.includes("OPT-IN"), "opt-in notice missing");
  assert.ok(!/apiKey|API_KEY/.test(bridge.replace("// without it nothing ever leaves", "")), "bridge must not hold credentials");
});

console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
