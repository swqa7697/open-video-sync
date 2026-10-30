CREATE TABLE identities (
    id TEXT PRIMARY KEY CHECK(length(id) = 32),
    display_name TEXT NOT NULL DEFAULT '' CHECK(length(display_name) <= 48 AND length(CAST(display_name AS BLOB)) <= 192),
    created_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
    identity_id TEXT NOT NULL REFERENCES identities(id),
    csrf_secret TEXT NOT NULL CHECK(length(csrf_secret) = 43),
    created_at_ms INTEGER NOT NULL,
    renewed_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms)
);
CREATE INDEX sessions_expiry ON sessions(expires_at_ms);
CREATE INDEX sessions_identity ON sessions(identity_id);
