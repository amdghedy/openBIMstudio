// Report-only hardening freeze (item 17, 2026-11-21).
//
// Wires the `no-restricted-syntax` __obs freeze and the explicit-`any` rule
// from the old `hardening.eslintrc.json` (deleted: legacy eslintrc format,
// nothing ever ran it) as WARN, never ERROR. The codebase currently carries
// 727 `__obs*` globals (ratchet ceiling, tests/ui-honesty.test.cjs) and
// ~2,722 explicit `any`s in src/, so an error-level freeze cannot pass
// today; this config exists to measure, not to block. `npm run lint:hardening`
// prints the per-rule counts. A future item may ratchet the counts down and
// flip these to error.
//
// The freeze message points at src/core/services.ts — the typed registry that
// is actually used. The old message named src/core/registry.ts, a 24-line
// stub nothing imported; it was deleted as dead in the same change.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: { parser: tsParser },
    plugins: { "@typescript-eslint": tsPlugin },
    // The codebase carries stale `eslint-disable` comments for rules this
    // config never enables (no-console, no-unused-vars); reporting them
    // would bury the freeze counts in noise.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "MemberExpression[object.name='window'][property.name=/^__obs/]",
          message: "window.__obs* bridges are frozen. Use src/core/services.ts.",
        },
        {
          selector: "Identifier[name=/^__obs/]",
          message: "Global __obs* state is frozen. Use the typed registry (src/core/services.ts).",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
