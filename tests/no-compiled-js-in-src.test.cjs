// Regression guard (#310 follow-up): a tracked src/**/*.js next to a .ts of the same name
// shadows the source in the Vite bundle (Vite resolves .js first). Fails if any git-tracked
// src/**/*.js has a sibling .ts/.tsx. Note: .gitignore does not untrack files; this test does.
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const tracked = execSync("git ls-files -- src", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const shadows = tracked.filter((f) => f.endsWith(".js") && (fs.existsSync(path.join(root, f.replace(/\.js$/, ".ts"))) || fs.existsSync(path.join(root, f.replace(/\.js$/, ".tsx")))));
assert.deepStrictEqual(shadows, [], "tracked compiled .js shadows its .ts source: " + shadows.join(", "));
console.log("PASS no tracked compiled .js shadows a .ts source (" + tracked.length + " tracked src files checked)");
