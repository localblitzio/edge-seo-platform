-- Insert Lantern Crest pilot config into the staging D1 `clients` table.
-- The config_json column is the source-of-truth ClientConfig (validated
-- by `npm run config:validate config/lantern-crest-staging.json` before
-- this insert per spec §7).
--
-- Run via:
--   npx wrangler d1 execute CONFIG_DB --env staging --remote \
--     --file=scripts/seed-lantern-crest-staging.sql

INSERT INTO clients (client_id, proxy_domain, source_domain, status, config_json, schema_version)
VALUES (
  'lantern-crest',
  'edge-seo-platform-staging.localblitzio.workers.dev',
  'lanterncrestseniorlivingsantee.com',
  'active',
  '{"client_id":"lantern-crest","proxy_domain":"edge-seo-platform-staging.localblitzio.workers.dev","source_domain":"lanterncrestseniorlivingsantee.com","authorization":{"attested_by_email":"simon@localblitz.io","attested_at":"2026-05-03T04:45:00Z","attested_ip":"0.0.0.0","scope":"full_site","expires_at":null},"status":"active","routing":[{"match":"^/.*","type":"proxy","origin":"https://lanterncrestseniorlivingsantee.com","origin_auth":{"type":"none"}}],"redirects":{"static":[],"patterns":[],"conditional":[]},"canonicals":[],"schema_injections":[],"link_rewrites":[],"element_removals":[],"content_injections":[],"meta_rewrites":[],"indexation":[],"caching":[],"forms":[],"schema_version":1}',
  1
);
