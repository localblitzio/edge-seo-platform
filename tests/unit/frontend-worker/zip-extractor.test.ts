import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  ZIP_ENTRY_MAX_BYTES,
  ZIP_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  contentTypeForPath,
  extractZip,
} from "../../../frontend-worker/src/zip-extractor.js";

function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const expanded: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) {
    expanded[k] = typeof v === "string" ? encoder.encode(v) : v;
  }
  return zipSync(expanded);
}

describe("extractZip", () => {
  it("walks a simple bundle and returns entries in normalized form", () => {
    const zip = makeZip({
      "index.html": "<h1>Hi</h1>",
      "css/main.css": "body{color:red}",
      "img/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    const result = extractZip(zip);
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(["css/main.css", "img/logo.png", "index.html"]);
    expect(result.totalBytes).toBe(11 + 15 + 4);
  });

  it("skips zero-byte directory entries", () => {
    const zip = makeZip({
      "subdir/": new Uint8Array(0),
      "subdir/file.txt": "ok",
    });
    const result = extractZip(zip);
    expect(result.files.map((f) => f.path)).toEqual(["subdir/file.txt"]);
  });

  it("normalizes backslashes from Windows-built zips", () => {
    const zip = makeZip({ "css\\main.css": "body{}" });
    const result = extractZip(zip);
    expect(result.files[0]?.path).toBe("css/main.css");
  });

  it("strips a leading `./` segment", () => {
    const zip = makeZip({ "./index.html": "<h1>Hi</h1>" });
    const result = extractZip(zip);
    expect(result.files[0]?.path).toBe("index.html");
  });

  it("rejects an entry with a `..` segment (zip-slip)", () => {
    const zip = makeZip({ "../escape.txt": "owned" });
    expect(() => extractZip(zip)).toThrow(/path traversal/);
  });

  it("rejects an absolute-path entry", () => {
    const zip = makeZip({ "/etc/passwd": "root:x" });
    expect(() => extractZip(zip)).toThrow(/path traversal/);
  });

  it("rejects a Windows drive-prefixed path", () => {
    const zip = makeZip({ "C:/win.txt": "owned" });
    expect(() => extractZip(zip)).toThrow(/path traversal/);
  });

  it("rejects a bundle exceeding the size cap", () => {
    // Building an actual 50MB+ buffer is expensive; assert the cap by
    // hand-feeding a slice with the correct size byte length.
    const big = new Uint8Array(ZIP_MAX_BYTES + 1);
    expect(() => extractZip(big)).toThrow(/exceeds .* bytes/);
  });

  it("rejects a bundle with too many entries", () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < ZIP_MAX_ENTRIES + 1; i++) entries[`f${i}.txt`] = "x";
    expect(() => extractZip(makeZip(entries))).toThrow(/exceeds .* entries/);
  });

  it("rejects a single oversized entry", () => {
    const oversize = new Uint8Array(ZIP_ENTRY_MAX_BYTES + 1).fill(0x61);
    const zip = makeZip({ "big.txt": oversize });
    expect(() => extractZip(zip)).toThrow(/exceeds .* bytes/);
  });
});

describe("contentTypeForPath", () => {
  it("maps common HTML/CSS/JS extensions", () => {
    expect(contentTypeForPath("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeForPath("main.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeForPath("app.js")).toBe("application/javascript; charset=utf-8");
  });

  it("maps common image and font types", () => {
    expect(contentTypeForPath("logo.png")).toBe("image/png");
    expect(contentTypeForPath("hero.jpg")).toBe("image/jpeg");
    expect(contentTypeForPath("icon.svg")).toBe("image/svg+xml");
    expect(contentTypeForPath("inter.woff2")).toBe("font/woff2");
  });

  it("returns undefined for files without an extension", () => {
    expect(contentTypeForPath("README")).toBeUndefined();
  });

  it("returns undefined for unknown extensions", () => {
    expect(contentTypeForPath("data.weirdext")).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    expect(contentTypeForPath("HERO.PNG")).toBe("image/png");
  });
});
