CREATE TABLE identities (
    id TEXT PRIMARY KEY CHECK(length(id) = 32),
    display_name TEXT NOT NULL DEFAULT '' CHECK(length(display_name) <= 48 AND length(CAST(display_name AS BLOB)) <= 192),
    created_at_ms INTEGER NOT NULL
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

CREATE TABLE rooms (
    id TEXT PRIMARY KEY CHECK(length(id) = 32),
    host_identity_id TEXT NOT NULL REFERENCES identities(id),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120 AND length(CAST(title AS BLOB)) <= 480),
    settings TEXT NOT NULL CHECK(json_valid(settings)),
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX rooms_host ON rooms(host_identity_id);

CREATE TABLE room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    identity_id TEXT NOT NULL REFERENCES identities(id),
    member_id TEXT NOT NULL CHECK(length(member_id) = 32),
    joined_at_ms INTEGER NOT NULL,
    PRIMARY KEY(room_id, identity_id),
    UNIQUE(room_id, member_id)
);
CREATE INDEX room_members_identity ON room_members(identity_id,room_id);

CREATE TABLE room_invitations (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
    link_hash TEXT NOT NULL UNIQUE CHECK(length(link_hash) = 64),
    code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash) = 64),
    link_secret TEXT NOT NULL CHECK(length(link_secret) = 22),
    code TEXT NOT NULL CHECK(length(code) = 16)
);

CREATE TABLE room_media (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    descriptor TEXT NOT NULL CHECK(json_valid(descriptor))
);

CREATE TABLE watch_history (
    identity_id TEXT NOT NULL REFERENCES identities(id),
    entry_id TEXT NOT NULL CHECK(length(entry_id) = 32),
    video TEXT NOT NULL CHECK(json_valid(video)),
    last_played_at_ms INTEGER NOT NULL,
    PRIMARY KEY(identity_id, entry_id)
);
CREATE INDEX watch_history_recent ON watch_history(identity_id, last_played_at_ms DESC, entry_id);

CREATE TABLE watch_history_preferences (
    identity_id TEXT PRIMARY KEY REFERENCES identities(id),
    recording_enabled INTEGER NOT NULL CHECK(recording_enabled IN (0, 1))
);

CREATE TABLE schema_migrations (
    migration_id INTEGER PRIMARY KEY CHECK(migration_id >= 1),
    checksum TEXT NOT NULL CHECK(length(checksum) = 64),
    applied_at_ms INTEGER NOT NULL
);
