const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve("src/features/ai-embeddings.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const values = new Map();
const local = new Map();
global.localStorage = {
  getItem: (key) => local.has(key) ? local.get(key) : null,
  setItem: (key, value) => local.set(key, String(value)),
  removeItem: (key) => local.delete(key),
};
const fakeModule = new Module(sourcePath, module);
fakeModule.filename = sourcePath;
fakeModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent === fakeModule && request === "../core/context") return { ctx: { fragments: { list: new Map() } } };
  if (parent === fakeModule && request === "../core/p-map") return { pMap: async (items, _limit, fn) => Promise.all(items.map(fn)) };
  if (parent === fakeModule && request === "../core/secure-store") return {
    secureGet: (key) => values.has(key) ? values.get(key) : null,
    secureSet: (key, value) => values.set(key, value),
    secureRemove: (key) => values.delete(key),
  };
  return originalLoad.call(this, request, parent, isMain);
};
try { fakeModule._compile(output, sourcePath); } finally { Module._load = originalLoad; }
const api = fakeModule.exports;
const cfgKey = "obs.ai.embeddings.config";
const secretKey = "ai.embeddings.apiKey";

function test(name, fn) {
  try { fn(); console.log("  PASS", name); }
  catch (error) { console.error("  FAIL", name, error); process.exitCode = 1; }
}

test("saves embedding API key outside plaintext localStorage", () => {
  api.saveEmbeddingConfig({
    provider: "openai", endpoint: "https://api.example.com",
    model: "embed-model", apiKey: "embedding-secret",
  });
  const persisted = local.get(cfgKey);
  assert.ok(persisted);
  assert.equal(persisted.includes("embedding-secret"), false);
  assert.equal(JSON.parse(persisted).apiKey, undefined);
  assert.equal(values.get(secretKey), "embedding-secret");
});

test("loads secure embedding API key", () => {
  const cfg = api.loadEmbeddingConfig();
  assert.equal(cfg.apiKey, "embedding-secret");
  assert.equal(cfg.model, "embed-model");
});

test("migrates legacy plaintext API key and removes it from public config", () => {
  values.clear();
  local.set(cfgKey, JSON.stringify({
    provider: "openai", endpoint: "https://api.example.com",
    model: "legacy-model", apiKey: "legacy-secret",
  }));
  const cfg = api.loadEmbeddingConfig();
  assert.equal(cfg.apiKey, "legacy-secret");
  assert.equal(values.get(secretKey), "legacy-secret");
  assert.equal(JSON.parse(local.get(cfgKey)).apiKey, undefined);
});

test("uses Vite proxy for default local Ollama endpoint on localhost", () => {
  global.location = { hostname: "localhost" };
  assert.equal(api.resolveOllamaBaseUrl("http://localhost:11434"), "/ollama");
});

test("honors custom Ollama endpoint even on localhost", () => {
  global.location = { hostname: "localhost" };
  assert.equal(api.resolveOllamaBaseUrl("http://127.0.0.1:11435/"), "http://127.0.0.1:11435");
});

test("uses configured Ollama endpoint on deployed hosts", () => {
  global.location = { hostname: "studio.example.com" };
  assert.equal(api.resolveOllamaBaseUrl("https://ollama.example.com/"), "https://ollama.example.com");
});

if (process.exitCode) process.exit(process.exitCode);
console.log("=== AI embeddings configuration tests complete ===");
