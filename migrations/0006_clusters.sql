-- Migration: 0006_clusters
-- Slice A of the Clusters feature: topical + geo groupings of 1–25
-- proxied sites that share a theme. Phase A is data + admin UI only —
-- subsequent slices wire clusters into link-project bulk-apply,
-- schema injection, cross-linking, etc.
-- Forward-only. Never edit a deployed migration; add a new one instead.

-- =============================================================================
-- clusters — single table, discriminator on `type`.
--
-- A cluster is a labeled grouping of 1–25 proxied sites that share
-- either a topic ("Plumbing", "Senior Living") or a geographic
-- identity ("San Diego, CA", "Texas"). The label carries the topic
-- or geo string; future slices may graduate type-specific columns
-- (lat/lon, topic taxonomy, etc.) once a real need emerges.
--
-- Multi-tenant: owner_id scopes visibility identically to clients +
-- link_projects. Super-admin sees all rows.
--
-- 1–25 cap is enforced at the validator layer, not the DB — keeps the
-- door open for "directory" clusters of 50+ if that becomes a thing.
--
-- description is optional operator scratchpad.
-- =============================================================================
CREATE TABLE clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('topical','geo')),
  label TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','archived')) DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_clusters_owner ON clusters(owner_id);
CREATE INDEX idx_clusters_type ON clusters(type);
CREATE INDEX idx_clusters_status ON clusters(status);

-- =============================================================================
-- cluster_members — many-to-many between clusters and clients.
--
-- A site (client_id) can belong to multiple clusters, including
-- multiple of the same type ("San Diego" + "California" GEO clusters
-- can both contain the same site). Composite primary key prevents
-- accidental duplicate (cluster, site) pairs.
--
-- ON DELETE CASCADE on cluster_id — deleting/archiving a cluster
-- removes the membership rows. clients.client_id is TEXT FK without
-- CASCADE (matches link_project_placements pattern), so deleting a
-- client leaves orphan rows that the admin UI hides via JOIN.
-- =============================================================================
CREATE TABLE cluster_members (
  cluster_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  notes TEXT,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cluster_id, client_id),
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX idx_cluster_members_client ON cluster_members(client_id);
