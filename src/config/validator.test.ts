import { describe, expect, it } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import { ConfigValidationError } from "../lib/errors.js";
import { ClientConfig } from "./schema.js";
import { assertConfigInvariants, checkRegexSafety } from "./validator.js";

function parseFixture(mut: (cfg: Record<string, unknown>) => void = () => {}): ClientConfig {
  const cfg = validLanternCrestConfig() as Record<string, unknown>;
  mut(cfg);
  return ClientConfig.parse(cfg);
}

describe("assertConfigInvariants — static redirects", () => {
  it("passes the canonical valid fixture", () => {
    const parsed = parseFixture();
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it("rejects duplicate from on static redirects", () => {
    const parsed = parseFixture((cfg) => {
      (cfg.redirects as Record<string, unknown>).static = [
        { from: "/old", to: "/new-1" },
        { from: "/old", to: "/new-2" },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(ConfigValidationError);
  });

  it("rejects more than 1000 inline static redirects", () => {
    const parsed = parseFixture((cfg) => {
      (cfg.redirects as Record<string, unknown>).static = Array.from({ length: 1001 }, (_, i) => ({
        from: `/from-${i}`,
        to: `/to-${i}`,
      }));
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/inline cap/i);
  });

  it("accepts exactly 1000 inline static redirects", () => {
    const parsed = parseFixture((cfg) => {
      (cfg.redirects as Record<string, unknown>).static = Array.from({ length: 1000 }, (_, i) => ({
        from: `/from-${i}`,
        to: `/to-${i}`,
      }));
    });
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });
});

describe("checkRegexSafety", () => {
  it("returns null on a safe pattern", () => {
    expect(checkRegexSafety("^/blog/.*$")).toBeNull();
  });

  it("rejects nested quantifiers like (a+)+", () => {
    expect(checkRegexSafety("(a+)+$")).toMatch(/nested quantifier/i);
  });

  it("rejects (a*)*", () => {
    expect(checkRegexSafety("(a*)*")).toMatch(/nested quantifier/i);
  });

  it("rejects (.+)+ wrapped against a path", () => {
    expect(checkRegexSafety("^/(.+)+$")).toMatch(/nested quantifier/i);
  });

  it("rejects non-capturing nested quantifier (?:a+|b)+", () => {
    expect(checkRegexSafety("(?:a+|b)+")).toMatch(/nested quantifier/i);
  });

  it("accepts (/.*)? — bounded outer quantifier (static-site shape)", () => {
    // The static-site upload emits `^<base>(/.*)?$`. The outer `?` is
    // bounded (0 or 1 reps) so there's no catastrophic backtracking,
    // even though the inner `*` matches arbitrary length.
    expect(checkRegexSafety("^/site1(/.*)?$")).toBeNull();
    expect(checkRegexSafety("^/lp/austin(/.*)?$")).toBeNull();
  });

  it("accepts a bounded {0,5} outer quantifier", () => {
    // Bounded ranges like {0,5} max out at 5 reps — not unbounded.
    expect(checkRegexSafety("(a+){0,5}")).toBeNull();
  });

  it("rejects an unbounded {n,} outer quantifier", () => {
    // {3,} has no upper bound — equivalent to `+` modulo the floor —
    // and IS a ReDoS vector when paired with an inner quantifier.
    expect(checkRegexSafety("(a+){3,}")).toMatch(/nested quantifier/i);
  });

  it("rejects patterns longer than 512 chars", () => {
    expect(checkRegexSafety("a".repeat(513))).toMatch(/512-character limit/);
  });

  it("rejects an invalid regex", () => {
    expect(checkRegexSafety("([)")).toMatch(/invalid regex/i);
  });

  it("accepts a 512-char pattern", () => {
    expect(checkRegexSafety("a".repeat(512))).toBeNull();
  });
});

describe("assertConfigInvariants — regex linter", () => {
  it("rejects nested quantifier in routing[].match", () => {
    const parsed = parseFixture((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "(a+)+$", type: "proxy", origin: "https://x.example" },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/routing\[0\]\.match/);
  });

  it("rejects nested quantifier in redirects.patterns[].pattern", () => {
    const parsed = parseFixture((cfg) => {
      (cfg.redirects as Record<string, unknown>).patterns = [
        { pattern: "(.+)+$", replacement: "/x" },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/redirects\.patterns\[0\]\.pattern/);
  });

  it("rejects nested quantifier in link_rewrites[].match_pattern", () => {
    const parsed = parseFixture((cfg) => {
      (cfg.link_rewrites as Array<Record<string, unknown>>) = [
        { match: "^/", match_pattern: "(a+)+", replacement: "/" },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/link_rewrites\[0\]\.match_pattern/);
  });

  it("rejects an over-long pattern with a clear path", () => {
    const parsed = parseFixture((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: `^${"a".repeat(513)}$`, strategy: { type: "self" } },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/canonicals\[0\]\.match/);
  });

  it("checks every regex-bearing field", () => {
    // sanity: walk every field with a known-bad pattern and confirm rejection
    const fields: Array<(cfg: Record<string, unknown>) => void> = [
      (cfg) => {
        (cfg.redirects as Record<string, unknown>).conditional = [
          {
            match: "(a+)+",
            conditions: [{ type: "geo_country", in: ["US"] }],
            to: "/x",
          },
        ];
      },
      (cfg) => {
        (cfg.schema_injections as Array<Record<string, unknown>>) = [
          { match: "(a+)+", schema_type: "Article", payload: { "@type": "Article" } },
        ];
      },
      (cfg) => {
        (cfg.element_removals as Array<Record<string, unknown>>) = [
          { match: "(a+)+", selector: ".badge" },
        ];
      },
      (cfg) => {
        (cfg.content_injections as Array<Record<string, unknown>>) = [
          { match: "(a+)+", selector: "body", position: "append", html: "<div></div>" },
        ];
      },
      (cfg) => {
        (cfg.meta_rewrites as Array<Record<string, unknown>>) = [
          { match: "(a+)+", tag: "title", value: "X" },
        ];
      },
      (cfg) => {
        (cfg.indexation as Array<Record<string, unknown>>) = [
          { match: "(a+)+", robots: "noindex,follow" },
        ];
      },
      (cfg) => {
        (cfg.caching as Array<Record<string, unknown>>) = [{ match: "(a+)+", ttl_seconds: 60 }];
      },
      (cfg) => {
        (cfg.forms as Array<Record<string, unknown>>) = [
          { match_action: "(a+)+", forward_to: "https://crm.example/lead" },
        ];
      },
    ];
    for (const mutate of fields) {
      const parsed = parseFixture(mutate);
      expect(() => assertConfigInvariants(parsed)).toThrow(ConfigValidationError);
    }
  });

  it("truncates very long patterns in error messages", () => {
    const parsed = parseFixture((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: `(a+)+${"x".repeat(200)}`, type: "proxy", origin: "https://x.example" },
      ];
    });
    try {
      assertConfigInvariants(parsed);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("...");
      expect(msg.length).toBeLessThan(300);
    }
  });
});

describe("assertConfigInvariants — JSON-LD serializability", () => {
  it("accepts a normal JSON-LD payload", () => {
    const parsed = parseFixture();
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it("rejects a payload with a function value", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    (firstInjection.payload as Record<string, unknown>).bad = (() => 1) as unknown;
    expect(() => assertConfigInvariants(parsed)).toThrow(/functions are not JSON-serializable/);
  });

  it("rejects a payload with a bigint value", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    (firstInjection.payload as Record<string, unknown>).bad = BigInt(10);
    expect(() => assertConfigInvariants(parsed)).toThrow(/bigint values are not JSON-serializable/);
  });

  it("rejects a payload with a symbol value", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    (firstInjection.payload as Record<string, unknown>).bad = Symbol("x") as unknown;
    expect(() => assertConfigInvariants(parsed)).toThrow(/symbols are not JSON-serializable/);
  });

  it("rejects a payload with a non-finite number", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    (firstInjection.payload as Record<string, unknown>).bad = Number.POSITIVE_INFINITY;
    expect(() => assertConfigInvariants(parsed)).toThrow(/non-finite/);
  });

  it("rejects a payload with undefined inside an array", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    (firstInjection.payload as Record<string, unknown>).list = [1, undefined as unknown, 3];
    expect(() => assertConfigInvariants(parsed)).toThrow(/undefined is not JSON-serializable/);
  });

  it("rejects a payload containing a cycle", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    const cyclic: Record<string, unknown> = { foo: "bar" };
    cyclic.self = cyclic;
    (firstInjection.payload as Record<string, unknown>).bad = cyclic;
    expect(() => assertConfigInvariants(parsed)).toThrow(ConfigValidationError);
  });

  it("accepts a payload with explicit null leaves", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    (firstInjection.payload as Record<string, unknown>).description = null;
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it("accepts a payload with a clean array of primitives", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    (firstInjection.payload as Record<string, unknown>).items = ["a", "b", { nested: ["c", "d"] }];
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it("walks nested arrays and objects to find bad leaves", () => {
    const parsed = parseFixture();
    const firstInjection = parsed.schema_injections[0];
    if (!firstInjection) throw new Error("fixture missing schema_injection");
    (firstInjection.payload as Record<string, unknown>).deeply = {
      nested: { array: [{ leaf: BigInt(7) }] },
    };
    expect(() => assertConfigInvariants(parsed)).toThrow(
      /deeply\.nested\.array\[0\]\.leaf.*bigint/,
    );
  });
});

describe("assertConfigInvariants — reserved subdomain on default zone", () => {
  it("rejects a default-zone proxy_domain whose leftmost label is reserved", () => {
    const parsed = parseFixture((cfg) => {
      cfg.proxy_domain = "www.localpage.us.com";
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/reserved/);
  });

  it("accepts a default-zone proxy_domain with a non-reserved label", () => {
    const parsed = parseFixture((cfg) => {
      cfg.proxy_domain = "lantern-crest.localpage.us.com";
    });
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it("does NOT apply the stoplist to custom (non-default-zone) domains", () => {
    // "www.example.com" is fine — operator chose their own zone, on which
    // they are responsible for any subdomain collisions.
    const parsed = parseFixture((cfg) => {
      cfg.proxy_domain = "www.example.com";
    });
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it("only checks the leftmost label for multi-level default-zone subdomains", () => {
    // "foo.www.localpage.us.com" — leftmost label is "foo", not reserved.
    const parsed = parseFixture((cfg) => {
      cfg.proxy_domain = "foo.www.localpage.us.com";
    });
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });
});

describe("assertConfigInvariants — in_place mode", () => {
  it("accepts in_place with an explicit non-overlapping origin", () => {
    const parsed = parseFixture((cfg) => {
      cfg.mode = "in_place";
      cfg.proxy_domain = "www.acme.com";
      cfg.source_domain = "www.acme.com";
      (cfg.routing as Array<Record<string, unknown>>) = [
        {
          match: "^/.*",
          type: "proxy",
          origin: "https://origin.acme.com",
          origin_auth: { type: "none" },
        },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it("rejects in_place when a proxy route has no origin", () => {
    const parsed = parseFixture((cfg) => {
      cfg.mode = "in_place";
      cfg.proxy_domain = "www.acme.com";
      cfg.source_domain = "www.acme.com";
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/.*", type: "proxy", origin_auth: { type: "none" } },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/origin is required when mode="in_place"/);
  });

  it("rejects in_place when origin host equals proxy_domain (loop guard)", () => {
    const parsed = parseFixture((cfg) => {
      cfg.mode = "in_place";
      cfg.proxy_domain = "www.acme.com";
      cfg.source_domain = "www.acme.com";
      (cfg.routing as Array<Record<string, unknown>>) = [
        {
          match: "^/.*",
          type: "proxy",
          origin: "https://www.acme.com",
          origin_auth: { type: "none" },
        },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/in_place mode would loop/);
  });

  it("matches the loop-guard case-insensitively (origin URL host casing varies)", () => {
    // proxy_domain is lowercase by schema rule, but URL hostnames can
    // mix case in the wild. The loop guard must still catch.
    const parsed = parseFixture((cfg) => {
      cfg.mode = "in_place";
      cfg.proxy_domain = "www.acme.com";
      cfg.source_domain = "www.acme.com";
      (cfg.routing as Array<Record<string, unknown>>) = [
        {
          match: "^/.*",
          type: "proxy",
          origin: "https://WWW.ACME.COM/",
          origin_auth: { type: "none" },
        },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/in_place mode would loop/);
  });

  it("rejects an invalid origin URL in in_place mode", () => {
    const parsed = parseFixture((cfg) => {
      cfg.mode = "in_place";
      cfg.proxy_domain = "www.acme.com";
      cfg.source_domain = "www.acme.com";
      (cfg.routing as Array<Record<string, unknown>>) = [
        {
          match: "^/.*",
          type: "proxy",
          origin: "not a url",
          origin_auth: { type: "none" },
        },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/not a valid URL/);
  });

  it("does NOT apply the in_place checks when mode is subdomain_proxy", () => {
    // Subdomain-proxy can fall through to the implicit origin derived
    // from source_domain — origin field is optional, no loop possible
    // since proxy_domain != source_domain by design.
    const parsed = parseFixture((cfg) => {
      cfg.mode = "subdomain_proxy";
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/.*", type: "proxy", origin_auth: { type: "none" } },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });
});

describe("assertConfigInvariants — in_place mode with resolve_override", () => {
  it("accepts origin host == proxy_domain when resolve_override is set", () => {
    // Managed-WP-host case: the WP server has a cert + vhost bound to
    // the customer's domain. We fetch via the public hostname (so
    // SNI + Host match) and override DNS resolution to a separate
    // record (so we don't loop through our own Workers Route).
    const parsed = parseFixture((cfg) => {
      cfg.mode = "in_place";
      cfg.proxy_domain = "acme.com";
      cfg.source_domain = "acme.com";
      (cfg.routing as Array<Record<string, unknown>>) = [
        {
          match: "^/.*",
          type: "proxy",
          origin: "https://acme.com",
          origin_auth: { type: "none" },
          resolve_override: "origin.acme.com",
        },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).not.toThrow();
  });

  it("rejects when resolve_override equals proxy_domain (loop guard)", () => {
    const parsed = parseFixture((cfg) => {
      cfg.mode = "in_place";
      cfg.proxy_domain = "acme.com";
      cfg.source_domain = "acme.com";
      (cfg.routing as Array<Record<string, unknown>>) = [
        {
          match: "^/.*",
          type: "proxy",
          origin: "https://acme.com",
          origin_auth: { type: "none" },
          resolve_override: "acme.com",
        },
      ];
    });
    expect(() => assertConfigInvariants(parsed)).toThrow(/resolve_override .* equals proxy_domain/);
  });

});
