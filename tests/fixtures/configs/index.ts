/**
 * Test fixtures shared by config / loader / integration tests.
 *
 * Negative fixtures are produced by mutating `validLanternCrestConfig`
 * in-place per test, so they live as functions rather than static JSON.
 */

import lanternCrest from "./lantern-crest.json" with { type: "json" };

/** A deep-cloned copy of the canonical valid config. */
export function validLanternCrestConfig(): unknown {
  return structuredClone(lanternCrest);
}
