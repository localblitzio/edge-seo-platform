import { describe, expect, it } from "vitest";

import { LIST_EDITOR_JS } from "../../../frontend-worker/src/list-editor-js.js";

/**
 * The list-editor JS is rendered into a `<script>` block on the new-client
 * and edit-client pages. Phase E v3 was rolled back because a previous
 * array-of-strings approach produced a `<script>` block V8 rejected with
 * "Unexpected end of input" — no test caught it before deploy.
 *
 * These tests parse the LIST_EDITOR_JS string in the same way V8 will at
 * runtime and assert it's syntactically valid. Any future regression that
 * breaks the parse (e.g. biome auto-format swapping quote styles in a way
 * that creates unbalanced syntax) fails the test before merge.
 */
describe("LIST_EDITOR_JS", () => {
  it("parses as valid JavaScript via new Function", () => {
    // new Function(...) parses the source at construction time. If the
    // source is syntactically invalid, this throws with a SyntaxError.
    expect(() => new Function(LIST_EDITOR_JS)).not.toThrow();
  });

  it("is non-empty and starts with the IIFE wrapper", () => {
    expect(LIST_EDITOR_JS.trim()).toMatch(/^\(function\s*\(\s*\)\s*\{/);
    expect(LIST_EDITOR_JS.trim()).toMatch(/\}\)\(\);?\s*$/);
  });

  it("references the data-path attribute pattern used by the entry cards", () => {
    expect(LIST_EDITOR_JS).toContain("dataset.path");
  });

  it("contains the five list-key entries the form expects", () => {
    for (const key of [
      "indexation",
      "canonicals",
      "schema_injections",
      "redirects.static",
      "meta_rewrites",
    ]) {
      expect(LIST_EDITOR_JS).toContain(key);
    }
  });

  it("exposes default-entry factories for each list key", () => {
    // The defaults are used when the user clicks + Add. Each must be
    // present in the source so the click handler can find them.
    expect(LIST_EDITOR_JS).toContain("DEFAULTS");
    // A few specific defaults — sanity that the factory shapes survived
    // any string transformation:
    expect(LIST_EDITOR_JS).toContain("'noindex,follow'");
    expect(LIST_EDITOR_JS).toContain("'origin'");
    expect(LIST_EDITOR_JS).toContain("'Article'");
    expect(LIST_EDITOR_JS).toContain("'@context'");
  });

  it("does not contain unescaped TS-style template-literal interpolation that would break in a String.raw context", () => {
    // The list editor JS is wrapped in String.raw`...` in TypeScript.
    // Any literal `${` would still trigger TS interpolation unless escaped
    // as `\${`. Verify there's no unescaped pattern that snuck in.
    // (We allow `\${...}` because the backslash escapes the `$`.)
    const matches = LIST_EDITOR_JS.match(/[^\\]\$\{/g);
    expect(matches).toBeNull();
  });
});
