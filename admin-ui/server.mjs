#!/usr/bin/env node
/**
 * Edge SEO Platform — local inspector.
 *
 * A read-only Phase-1 dev tool that reads the same Miniflare state the
 * Worker uses (D1 + KV at .wrangler/state/v3/) and renders it as a
 * server-side HTML dashboard. Phase 2 admin UI (PRD §7.12, tech spec
 * §15) replaces this entirely with a full editor + workflow.
 *
 * Usage: `npm run admin` (defaults to port 4000).
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isSeeded, listKv, readClient, readD1, readKvValue } from "./data.mjs";
import {
  auditView,
  clientDetailView,
  clientsView,
  kvDetailView,
  kvView,
  layout,
  overviewView,
  redirectsView,
} from "./views.mjs";

const PORT = Number(process.env.ADMIN_PORT ?? 4000);
const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(ROOT, "static");

function send(res, status, contentType, body) {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function sendHtml(res, body, status = 200) {
  send(res, status, "text/html; charset=utf-8", body);
}

function sendStatic(res, fileName) {
  try {
    const path = join(STATIC_DIR, fileName);
    const body = readFileSync(path);
    const ext = fileName.split(".").pop();
    const contentType =
      ext === "css"
        ? "text/css; charset=utf-8"
        : ext === "js"
          ? "application/javascript; charset=utf-8"
          : "application/octet-stream";
    send(res, 200, contentType, body);
  } catch {
    send(res, 404, "text/plain", "Not found");
  }
}

function render(res, { title, content, activeNav, clients }) {
  const stale = !isSeeded();
  sendHtml(res, layout({ title, content, activeNav, clients: clients ?? [], stale }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path.startsWith("/static/")) {
    return sendStatic(res, path.slice("/static/".length));
  }

  // Read fresh on every request — local Miniflare state can change
  // out from under us (seed re-run, Worker request that wrote through).
  const d1 = readD1();
  const kv = listKv();
  const clients = d1.clients ?? [];

  try {
    if (path === "/" || path === "") {
      return render(res, {
        title: "Overview",
        content: overviewView({ d1, kv }),
        activeNav: "home",
        clients,
      });
    }
    if (path === "/clients") {
      return render(res, {
        title: "Clients",
        content: clientsView({ d1 }),
        activeNav: "clients",
        clients,
      });
    }
    if (path.startsWith("/clients/")) {
      const clientId = decodeURIComponent(path.slice("/clients/".length));
      const client = readClient(clientId);
      return render(res, {
        title: client ? clientId : "Not found",
        content: clientDetailView({ client }),
        activeNav: `client:${clientId}`,
        clients,
      });
    }
    if (path === "/redirects") {
      return render(res, {
        title: "Redirect rules",
        content: redirectsView({ d1 }),
        activeNav: "redirects",
        clients,
      });
    }
    if (path === "/audit") {
      return render(res, {
        title: "Audit log",
        content: auditView({ d1 }),
        activeNav: "audit",
        clients,
      });
    }
    if (path === "/kv") {
      return render(res, {
        title: "KV browser",
        content: kvView({ kv }),
        activeNav: "kv",
        clients,
      });
    }
    if (path.startsWith("/kv/")) {
      const key = decodeURIComponent(path.slice("/kv/".length));
      const value = readKvValue(key);
      return render(res, {
        title: key,
        content: kvDetailView({ key, value }),
        activeNav: "kv",
        clients,
      });
    }

    return render(res, {
      title: "Not found",
      content: `<h1>Not found</h1><div class="empty">No page at <code>${path}</code>.</div>`,
      activeNav: "",
      clients,
    });
  } catch (e) {
    console.error("[admin-ui] error rendering", path, e);
    return sendHtml(
      res,
      layout({
        title: "Error",
        content: `<h1>Inspector error</h1>
          <div class="banner">${(e instanceof Error ? e.message : String(e))
            .replace(/[<>&]/g, "")}</div>
          <pre class="json-block">${(e instanceof Error ? e.stack : String(e))?.replace(
            /[<>&]/g,
            "",
          )}</pre>`,
        activeNav: "",
        clients,
        stale: false,
      }),
      500,
    );
  }
});

server.listen(PORT, () => {
  console.log(`Edge SEO Platform inspector → http://localhost:${PORT}`);
  if (!isSeeded()) {
    console.log("(Miniflare D1 store missing — run `npm run demo:seed` to populate it.)");
  }
});
