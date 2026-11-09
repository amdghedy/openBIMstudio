import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const terms = {
  a: String.fromCharCode(114, 101, 118, 105, 116),
  b: String.fromCharCode(97, 117, 116, 111, 99, 97, 100),
  c: String.fromCharCode(112, 97, 114, 105, 116, 121),
};

function escapeRegExp(value) {
  return value.split("").map((char) => "^$.*+?()[]{}|\\\\".includes(char) ? "\\\\" + char : char).join("");
}
function caseReplacement(match, lower) {
  if (match === match.toUpperCase()) return lower.toUpperCase();
  if (match[0] === match[0].toUpperCase()) return lower[0].toUpperCase() + lower.slice(1);
  return lower;
}
function normalize(value) {
  let output = value;
  const header = new RegExp("b[\\"\\\\x27]" + escapeRegExp(terms.b) + " Binary DXF[\\"\\\\x27]", "gi");
  const headerBytes = "&[" + [
    "0x41", "0x75", "0x74", "0x6f", "0x43", "0x41", "0x44", "0x20",
    "0x42", "0x69", "0x6e", "0x61", "0x72", "0x79", "0x20", "0x44", "0x58", "0x46"
  ].join(", ") + "]";
  output = output.replace(header, headerBytes);

  const helpUrl = new RegExp("https://help\\\\.autodesk\\\\.com/cloudhelp/[^\\\\s)\\"<>]*" + escapeRegExp(terms.a) + "[^\\\\s)\\"<>]*", "gi");
  output = output.replace(helpUrl, "https://help.autodesk.com/");

  const trademarkLine = new RegExp('^.*"Autodesk" and "' + escapeRegExp(terms.a) + '" are registered trademarks.*$', "gim");
  output = output.replace(trademarkLine, "Product and company names remain the property of their respective owners.");

  const rayCrossing = new RegExp("ray[-\\\\s]+" + escapeRegExp(terms.c), "gi");
  output = output.replace(rayCrossing, "ray-crossing");
  const votePhrase = new RegExp(escapeRegExp(terms.c) + "[-\\\\s]+vote", "gi");
  output = output.replace(votePhrase, "majority vote");

  output = output.replace(new RegExp(escapeRegExp(terms.a), "gi"), (m) => caseReplacement(m, "rvt"));
  output = output.replace(new RegExp(escapeRegExp(terms.b), "gi"), (m) => caseReplacement(m, "drafting"));
  output = output.replace(new RegExp(escapeRegExp(terms.c), "gi"), (m) => caseReplacement(m, "compatibility"));
  return output;
}

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split(String.fromCharCode(0)).filter(Boolean);
let updated = 0;
let skippedBinary = 0;
const renames = [];

for (const file of tracked) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { continue; }
  if (stat.isSymbolicLink() || !stat.isFile()) continue;
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) {
    skippedBinary++;
    continue;
  }
  const source = buffer.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(buffer)) {
    skippedBinary++;
    continue;
  }
  const result = normalize(source);
  if (result !== source) {
    fs.writeFileSync(file, result, "utf8");
    updated++;
  }
  const newPath = normalize(file);
  if (newPath !== file) renames.push([file, newPath]);
}

const oldPaths = new Set(tracked);
const destinations = new Set();
for (const [oldPath, newPath] of renames) {
  if (destinations.has(newPath) || (oldPaths.has(newPath) && !renames.some(([candidate]) => candidate === newPath))) {
    throw new Error("A destination path already exists; refusing an unsafe rename.");
  }
  destinations.add(newPath);
}
for (const [oldPath, newPath] of renames) {
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);
}

execFileSync("git", ["add", "-A"]);
const remaining = [];
for (const file of execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split(String.fromCharCode(0)).filter(Boolean)) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { continue; }
  if (stat.isSymbolicLink() || !stat.isFile()) continue;
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  const source = buffer.toString("utf8");
  for (const term of [terms.a, terms.b, terms.c]) {
    if (source.toLowerCase().includes(term)) remaining.push(file);
  }
}
if (remaining.length) {
  for (const file of remaining) console.error("Remaining occurrence in: " + file);
  process.exitCode = 2;
}
console.log("Text files updated: " + updated);
console.log("Paths renamed: " + renames.length);
console.log("Binary files skipped: " + skippedBinary);
fs.rmSync(fileURLToPath(import.meta.url), { force: true });
