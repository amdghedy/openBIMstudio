/**
 * review-links node suite (differentiation item 8).
 *
 * Runs the REAL pure core (review-links-core.ts) and the REAL review-mode
 * flag (review-state.ts) — the link the author copies, the URL the
 * reviewer's browser parses, and the read-only tool sets the edit gates
 * enforce. The browser spec proves the loop end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewLink,
  isFetchableModelUrl,
  isReadOnlyAnnotationTool,
  isReadOnlyAuthoringTool,
  isReadOnlyPlanTool,
  parseReviewSearch,
} from "../src/modules/review/review-links-core";
import { isReviewMode, setReviewMode } from "../src/modules/review/review-state";

const APP = "https://openbimstudio.app/";

test("buildReviewLink: https model URL becomes a ?review= link, encoded", () => {
  const link = buildReviewLink(APP, "https://files.example.com/models/Review Demo.obsproj");
  assert.equal(
    link,
    "https://openbimstudio.app/?review=https%3A%2F%2Ffiles.example.com%2Fmodels%2FReview%20Demo.obsproj",
  );
});

test("buildReviewLink: non-http(s) and relative model URLs are refused, never a broken link", () => {
  assert.throws(() => buildReviewLink(APP, "ftp://files.example.com/m.obsproj"), /not a usable model URL/);
  assert.throws(() => buildReviewLink(APP, "/models/m.obsproj"), /not a usable model URL/);
  assert.throws(() => buildReviewLink(APP, "   "), /not a usable model URL/);
  assert.equal(isFetchableModelUrl("http://127.0.0.1:3109/model.obsproj"), true);
  assert.equal(isFetchableModelUrl("obsproj"), false);
});

test("parseReviewSearch: ?review=<url> carries the model, bare ?review reviews the open model", () => {
  const withUrl = parseReviewSearch("?review=https%3A%2F%2Ffiles.example.com%2Fm.obsproj");
  assert.equal(withUrl.review, true);
  assert.equal(withUrl.modelUrl, "https://files.example.com/m.obsproj");
  const bare = parseReviewSearch("?review");
  assert.equal(bare.review, true);
  assert.equal(bare.modelUrl, null);
  const bareEq = parseReviewSearch("?review=");
  assert.equal(bareEq.review, true);
  assert.equal(bareEq.modelUrl, null);
});

test("parseReviewSearch: no review parameter means normal mode", () => {
  assert.deepEqual(parseReviewSearch(""), { review: false, modelUrl: null });
  assert.deepEqual(parseReviewSearch("?foo=bar"), { review: false, modelUrl: null });
});

test("read-only sets: 3D authoring allows select (and clearing) only", () => {
  assert.equal(isReadOnlyAuthoringTool("select"), true);
  assert.equal(isReadOnlyAuthoringTool(null), true);
  for (const t of ["wall", "door", "window", "move", "copy", "rotate", "mirror", "array", "offset", "slab", "grid"]) {
    assert.equal(isReadOnlyAuthoringTool(t), false, t);
  }
});

test("read-only sets: plan allows select/pan/navigate; measure is a dimension alias, not read-only", () => {
  assert.equal(isReadOnlyPlanTool("select"), true);
  assert.equal(isReadOnlyPlanTool("pan"), true);
  assert.equal(isReadOnlyPlanTool("navigate"), true);
  for (const t of ["wall", "door", "window", "measure", "dim-aligned", "tag-category", "section-line"]) {
    assert.equal(isReadOnlyPlanTool(t), false, t);
  }
  assert.equal(isReadOnlyAnnotationTool("select"), true);
  for (const t of ["dim-aligned", "dim-linear", "tag-category", "section-line"]) {
    assert.equal(isReadOnlyAnnotationTool(t), false, t);
  }
});

test("review-state: the flag toggles and is off by default", () => {
  setReviewMode(false);
  assert.equal(isReviewMode(), false);
  setReviewMode(true);
  assert.equal(isReviewMode(), true);
  setReviewMode(false);
  assert.equal(isReviewMode(), false);
});
