import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROXY_ZONE,
  PROXY_ZONES,
  RESERVED_SUBDOMAINS,
  defaultProxyDomainFor,
  isProxyZoneDomain,
  matchProxyZone,
  subdomainOfProxyZone,
} from "./proxy-zone.js";

describe("PROXY_ZONES", () => {
  it("has DEFAULT_PROXY_ZONE as the first entry", () => {
    expect(PROXY_ZONES[0]).toBe(DEFAULT_PROXY_ZONE);
  });

  it("contains both registered zones", () => {
    expect(PROXY_ZONES).toContain("localpage.us.com");
    expect(PROXY_ZONES).toContain("localsite.us.com");
  });
});

describe("matchProxyZone", () => {
  it("returns the matching zone for a single-label subdomain", () => {
    expect(matchProxyZone(`acme.${DEFAULT_PROXY_ZONE}`)).toBe(DEFAULT_PROXY_ZONE);
  });

  it("matches secondary zones too", () => {
    expect(matchProxyZone("acme.localsite.us.com")).toBe("localsite.us.com");
  });

  it("matches multi-label subdomains", () => {
    expect(matchProxyZone(`foo.bar.${DEFAULT_PROXY_ZONE}`)).toBe(DEFAULT_PROXY_ZONE);
  });

  it("returns null for an unknown zone", () => {
    expect(matchProxyZone("client.example.com")).toBeNull();
  });

  it("returns null for the bare zone (no subdomain)", () => {
    expect(matchProxyZone(DEFAULT_PROXY_ZONE)).toBeNull();
  });

  it("returns null for a zone that just shares a suffix (substring trick)", () => {
    // "fakelocalpage.us.com" must not match "localpage.us.com" — the leading
    // dot in the check `endsWith(".${zone}")` defends against this.
    expect(matchProxyZone(`fake${DEFAULT_PROXY_ZONE}`)).toBeNull();
  });
});

describe("isProxyZoneDomain", () => {
  it("returns true for a subdomain on any registered zone", () => {
    for (const zone of PROXY_ZONES) {
      expect(isProxyZoneDomain(`acme.${zone}`)).toBe(true);
    }
  });

  it("returns false for an unknown zone", () => {
    expect(isProxyZoneDomain("client.example.com")).toBe(false);
  });
});

describe("defaultProxyDomainFor", () => {
  it("constructs `<id>.${DEFAULT_PROXY_ZONE}`", () => {
    expect(defaultProxyDomainFor("acme")).toBe(`acme.${DEFAULT_PROXY_ZONE}`);
  });

  it("does not validate the id (caller's responsibility)", () => {
    // Demonstrates the contract — invalid input still concatenates.
    expect(defaultProxyDomainFor("Bad-ID")).toBe(`Bad-ID.${DEFAULT_PROXY_ZONE}`);
  });
});

describe("subdomainOfProxyZone", () => {
  it("returns the single leftmost label for `<id>.${DEFAULT_PROXY_ZONE}`", () => {
    expect(subdomainOfProxyZone(`acme.${DEFAULT_PROXY_ZONE}`)).toBe("acme");
  });

  it("returns the prefix on a non-default zone too", () => {
    expect(subdomainOfProxyZone("acme.localsite.us.com")).toBe("acme");
  });

  it("returns the full multi-label prefix unchanged", () => {
    expect(subdomainOfProxyZone(`foo.bar.${DEFAULT_PROXY_ZONE}`)).toBe("foo.bar");
  });

  it("returns null for a non-platform-zone domain", () => {
    expect(subdomainOfProxyZone("client.example.com")).toBeNull();
  });

  it("returns null for the bare zone", () => {
    expect(subdomainOfProxyZone(DEFAULT_PROXY_ZONE)).toBeNull();
  });
});

describe("RESERVED_SUBDOMAINS", () => {
  it("contains the obvious infrastructure labels", () => {
    for (const sub of ["www", "api", "admin", "mail", "ssl"]) {
      expect(RESERVED_SUBDOMAINS.has(sub)).toBe(true);
    }
  });

  it("does not include common client-id shapes", () => {
    for (const sub of ["acme", "lantern-crest", "client-1", "tenant42"]) {
      expect(RESERVED_SUBDOMAINS.has(sub)).toBe(false);
    }
  });

  it("uses lowercase entries (matches the tightened client_id regex)", () => {
    for (const sub of RESERVED_SUBDOMAINS) {
      expect(sub).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
