const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve("src/features/ai-tools.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const authored = [];
let level = 1.25;
let locationLine = "finish-exterior";
let wallOffset = 0.15;
const authoringMock = {
  addLinearElement: async (type, x1, z1, x2, z2, elevation, size) => {
    authored.push({
      id: `native-${authored.length + 1}`,
      type, start: [x1, z1], end: [x2, z2], elevation, ...size,
    });
  },
  getLevel: () => level,
  setLevel: (value) => { level = value; },
  getWallLocationLine: () => locationLine,
  setWallLocationLine: (value) => { locationLine = value; },
  getWallOffset: () => wallOffset,
  setWallOffset: (value) => { wallOffset = value; },
};
const servicesMock = {
  tryUse: (name) => name === "authoring" ? {
    getElements: () => authored,
    getElementCount: () => authored.length,
    // Real createElementByType contract: (type, params, hostId?) → id | null.
    createElementByType: async (type, params, hostId) => {
      const el = {
        id: `native-${authored.length + 1}`,
        type, params: { ...(params ?? {}) },
        ...(hostId ? { hostId } : {}),
      };
      authored.push(el);
      return el.id;
    },
  } : undefined,
};

/* ── Load the REAL nl-model (parser/planner/executor) from TS ──────────
   create_room is tested against the real words-to-room code, not a stub
   of it — only the authoring engine behind it is faked (above). */
const nlModelCache = new Map();
function loadTsModule(filePath) {
  if (nlModelCache.has(filePath)) return nlModelCache.get(filePath);
  const text = fs.readFileSync(filePath, "utf8");
  const js = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(filePath, module);
  m.filename = filePath;
  m.paths = Module._nodeModulePaths(path.dirname(filePath));
  m._compile(js, filePath);
  nlModelCache.set(filePath, m.exports);
  return m.exports;
}
const nlModelDir = path.resolve("src/modules/nl-model");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../core/context") return { ctx: { fragments: { list: new Map() }, features: {} } };
  if (request === "../core/services") return { services: servicesMock };
  if (request === "./command-palette") return { listCommands: () => [], registerCommand: () => {} };
  if (request === "./authoring") return authoringMock;
  // Lazy: the hook must exist before the first nl-model file loads, because
  // index.ts requires ./parse, ./plan and ./execute relatively.
  if (request === "../modules/nl-model/index") return loadTsModule(path.join(nlModelDir, "index.ts"));
  if (request === "./parse") return loadTsModule(path.join(nlModelDir, "parse.ts"));
  if (request === "./plan") return loadTsModule(path.join(nlModelDir, "plan.ts"));
  if (request === "./execute") return loadTsModule(path.join(nlModelDir, "execute.ts"));
  return originalLoad.call(this, request, parent, isMain);
};

const aiModule = new Module(sourcePath, module);
aiModule.filename = sourcePath;
aiModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
aiModule._compile(output, sourcePath);

const { executeTool, TOOLS, requiresUserApproval, isDestructiveTool } = aiModule.exports;

async function test(name, fn) {
  try { await fn(); console.log("  PASS", name); }
  catch (error) { console.error("  FAIL", name, error); process.exitCode = 1; }
}

(async () => {
  await test("registers a native linear modeling tool with required geometry", () => {
    const tool = TOOLS.find((item) => item.name === "create_linear_elements");
    assert.ok(tool, "tool is missing");
    assert.deepEqual(tool.parameters.required, ["type", "segments"]);
  });


  await test("registers a create_room tool that takes a plain sentence", () => {
    const tool = TOOLS.find((item) => item.name === "create_room");
    assert.ok(tool, "tool is missing");
    assert.deepEqual(tool.parameters.required, ["text"]);
  });


  await test("requires approval for every model-writing operation", () => {
    for (const name of ["create_linear_elements", "create_room", "create_walls_from_cad", "create_issue", "create_schedule"]) {
      assert.equal(requiresUserApproval(name), true, name + " must require approval");
    }
    for (const name of ["get_app_state", "get_model_categories", "get_element_properties", "run_clash_test"]) {
      assert.equal(requiresUserApproval(name), false, name + " should remain read-only");
    }
    assert.equal(requiresUserApproval("create_walls_from_cad", { dryRun: true }), false, "CAD analysis-only dry run should not require write approval");
    assert.equal(requiresUserApproval("create_walls_from_cad", { dryRun: false }), true, "CAD wall creation must require approval");
    assert.equal(isDestructiveTool("delete_elements"), true);
    assert.equal(requiresUserApproval("delete_elements"), true);
  });

  await test("creates a native wall through the authoring engine", async () => {
    const result = await executeTool({
      id: "test-wall", name: "create_linear_elements",
      args: {
        type: "wall",
        segments: [{ start: [0, 0], end: [5, 0] }],
        elevation: 0, thickness: 0.2, height: 3,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.created, 1);
    assert.equal(result.data.type, "wall");
    assert.equal(authored[0].type, "wall");
    assert.deepEqual(authored[0].start, [0, 0]);
    assert.deepEqual(authored[0].end, [5, 0]);
    assert.equal(authored[0].thickness, 0.2);
    assert.equal(authored[0].height, 3);
    assert.equal(level, 1.25, "active level was not restored");
    assert.equal(locationLine, "finish-exterior", "wall location line was not restored");
    assert.equal(wallOffset, 0.15, "wall offset was not restored");
  });

  await test("creates multiple native MEP linear elements", async () => {
    const result = await executeTool({
      id: "test-duct", name: "create_linear_elements",
      args: {
        type: "duct",
        segments: [
          { start: [0, 0], end: [4, 0], elevation: 2.8, thickness: 0.4, height: 0.25 },
          { start: [4, 0], end: [4, 3], elevation: 2.8, thickness: 0.4, height: 0.25 },
        ],
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.created, 2);
    assert.equal(authored[1].type, "duct");
    assert.equal(authored[2].type, "duct");
    assert.deepEqual(authored[2].end, [4, 3]);
  });

  await test("rejects missing coordinates without mutating the model", async () => {
    const before = authored.length;
    const result = await executeTool({
      id: "bad-geometry", name: "create_linear_elements",
      args: { type: "wall", segments: [{ start: [0], end: [2, 0] }] },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /exactly two coordinates/);
    assert.equal(authored.length, before);
  });

  await test("rejects zero-length segments without mutating the model", async () => {
    const before = authored.length;
    const result = await executeTool({
      id: "zero-length", name: "create_linear_elements",
      args: { type: "wall", segments: [{ start: [1, 1], end: [1, 1] }] },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /shorter than 1 mm/);
    assert.equal(authored.length, before);
  });

  await test("create_room models a 4×6 room with a door and two windows", async () => {
    const before = authored.length;
    const result = await executeTool({
      id: "test-room", name: "create_room",
      args: { text: "draw a 4×6 room with a door and two windows" },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.room.width, 4);
    assert.equal(result.data.room.depth, 6);
    assert.equal(result.data.walls.length, 4);
    assert.equal(result.data.doors, 1);
    assert.equal(result.data.windows, 2);
    const made = authored.slice(before);
    assert.equal(made.filter((e) => e.type === "wall").length, 4);
    assert.equal(made.filter((e) => e.type === "door").length, 1);
    assert.equal(made.filter((e) => e.type === "window").length, 2);
    for (const o of made.filter((e) => e.type === "door" || e.type === "window")) {
      assert.ok(result.data.walls.includes(o.hostId), `${o.type} hosted on an unknown wall`);
    }
  });

  await test("create_room rejects an unparseable sentence without mutating the model", async () => {
    const before = authored.length;
    const result = await executeTool({
      id: "bad-room", name: "create_room",
      args: { text: "draw something nice" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not describe a room/);
    assert.equal(authored.length, before);
  });

  await test("rejects unsupported element types", async () => {
    const before = authored.length;
    const result = await executeTool({
      id: "unsupported", name: "create_linear_elements",
      args: { type: "door", segments: [{ start: [0, 0], end: [1, 0] }] },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Unsupported linear element type/);
    assert.equal(authored.length, before);
  });

  await test("rejects requests over the segment safety limit", async () => {
    const before = authored.length;
    const segments = Array.from({ length: 101 }, (_, i) => ({
      start: [i, 0], end: [i + 1, 0],
    }));
    const result = await executeTool({
      id: "too-many", name: "create_linear_elements",
      args: { type: "wall", segments },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /limited to 100/);
    assert.equal(authored.length, before);
  });

  Module._load = originalLoad;
  if (process.exitCode) process.exit(process.exitCode);
  console.log("=== AI native modeling tests complete ===");
})();
