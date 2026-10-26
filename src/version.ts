/**
 * Single source of application version metadata (remediation program Phase 2.1).
 *
 * package.json stays the npm-level source; this module is the in-app source
 * consumed by the plugin host, the About dialog, and diagnostics. A test pins
 * the two values together so they cannot drift again (tests/version-consistency.test.cjs).
 */
export const APP_VERSION = "0.73.0";
