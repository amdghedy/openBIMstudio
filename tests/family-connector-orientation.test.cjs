const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-family-connector-orientation-"));

try {
  const source = path.join(root, "src/modules/families/connector-orientation.ts");
  execSync("npx tsc \"" + source + "\" --outDir \"" + out +
    "\" --module commonjs --target es2020 --strict --skipLibCheck",
    { cwd: root, stdio: "pipe" });
  const findCompiled = (dir, file) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findCompiled(full, file);
        if (found) return found;
      } else if (entry.isFile() && entry.name === file) return full;
    }
    return null;
  };
  const compiled = findCompiled(out, "connector-orientation.js");
  assert.ok(compiled, "compiled connector orientation module not found");
  const {
    normalizeConnectorDirection,
    connectorDirectionToYawPitch,
    yawPitchToConnectorDirection,
  } = require(compiled);

  let pass = 0, fail = 0;
  const test = (name, fn) => {
    try { fn(); pass++; console.log("  PASS " + name); }
    catch (error) { fail++; console.error("  FAIL " + name + ": " + error.message); }
  };
  const close = (actual, expected, epsilon = 1e-9) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => assert.ok(
      Math.abs(value - expected[index]) <= epsilon,
      "index " + index + ": expected " + expected[index] + ", got " + value,
    ));
  };
  const roundTrip = (yaw, pitch) => {
    const vector = yawPitchToConnectorDirection(yaw, pitch);
    const angles = connectorDirectionToYawPitch(vector);
    assert.ok(Math.abs(angles.pitchDeg - pitch) < 1e-8);
    if (Math.abs(pitch) < 89.999999) {
      const yawDelta = ((angles.yawDeg - yaw + 540) % 360) - 180;
      assert.ok(Math.abs(yawDelta) < 1e-8);
    }
    close(vector, normalizeConnectorDirection(vector));
  };

  test("maps positive local axes to the documented yaw/pitch convention", () => {
    close(yawPitchToConnectorDirection(0, 0), [1, 0, 0]);
    close(yawPitchToConnectorDirection(90, 0), [0, 0, 1]);
    close(yawPitchToConnectorDirection(0, 90), [0, 1, 0]);
    close(yawPitchToConnectorDirection(0, -90), [0, -1, 0]);
  });

  test("round-trips arbitrary directions through yaw and pitch", () => {
    roundTrip(32.5, 18.25);
    roundTrip(-147.2, -63.4);
    roundTrip(179.9, 0.01);
    roundTrip(0, 90);
    roundTrip(0, -90);
  });

  test("normalizes non-unit input without mutating it", () => {
    const source = [2, 2, 1];
    const before = [...source];
    const normalized = normalizeConnectorDirection(source);
    assert.ok(Math.abs(Math.hypot(...normalized) - 1) < 1e-12);
    close(source, before);
    assert.notEqual(normalized, source);
  });

  test("normalizes yaw wrap-around and always returns a unit vector", () => {
    close(
      yawPitchToConnectorDirection(450, 0),
      yawPitchToConnectorDirection(90, 0),
    );
    close(
      yawPitchToConnectorDirection(-270, 15),
      yawPitchToConnectorDirection(90, 15),
    );
  });

  test("rejects zero, malformed and non-finite direction vectors", () => {
    assert.throws(() => normalizeConnectorDirection([0, 0, 0]), /non-zero/);
    assert.throws(() => normalizeConnectorDirection([1, 0]), /three finite coordinates/);
    assert.throws(() => normalizeConnectorDirection([1, Number.NaN, 0]), /three finite coordinates/);
    assert.throws(() => connectorDirectionToYawPitch([Infinity, 0, 0]), /three finite coordinates/);
  });

  test("rejects non-finite angles and pitch outside the physical range", () => {
    assert.throws(() => yawPitchToConnectorDirection(Number.NaN, 0), /must be finite/);
    assert.throws(() => yawPitchToConnectorDirection(0, Infinity), /must be finite/);
    assert.throws(() => yawPitchToConnectorDirection(0, 90.01), /between -90° and 90°/);
    assert.throws(() => yawPitchToConnectorDirection(0, -90.01), /between -90° and 90°/);
  });

  const browserSource = fs.readFileSync(
    path.join(root, "src/features/family-browser.ts"), "utf8",
  );
  test("Family Browser exposes yaw/pitch controls and refreshes the preview", () => {
    assert.ok(browserSource.includes("connectorDirectionToYawPitch"));
    assert.ok(browserSource.includes("yawPitchToConnectorDirection"));
    assert.ok(browserSource.includes('makeAngleInput("YAW (°)"'));
    assert.ok(browserSource.includes('makeAngleInput("PITCH (°)"'));
    assert.ok(browserSource.includes("draft.direction = direction.map(String)"));
    assert.ok(browserSource.includes("The preview arrow reflects this draft"));
    assert.ok(browserSource.includes("afterChange?.()"));
  });

  console.log("=== Family connector orientation tests: " + pass + " passed, " + fail + " failed ===");
  process.exitCode = fail ? 1 : 0;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
