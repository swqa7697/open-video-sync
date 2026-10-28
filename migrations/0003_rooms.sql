CREATE TABLE rooms (
    id TEXT PRIMARY KEY CHECK(length(id) = 32),
    host_identity_id TEXT NOT NULL REFERENCES identities(id),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120 AND length(CAST(title AS BLOB)) <= 480),
    settings TEXT NOT NULL CHECK(json_valid(settings)),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    created_at_ms INTEGER NOT NULL,
    last_active_at_ms INTEGER NOT NULL
);
CREATE INDEX rooms_activity ON rooms(last_active_at_ms);
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
    expires_at_ms INTEGER NOT NULL
);
CREATE INDEX invitations_expiry ON room_invitations(expires_at_ms);
CREATE TABLE http_idempotency (
    identity_id TEXT NOT NULL REFERENCES identities(id),
    operation TEXT NOT NULL CHECK(operation IN ('rooms.create','invitations.redeem')),
    key TEXT NOT NULL CHECK(length(key) = 32),
    digest TEXT NOT NULL CHECK(length(digest) = 64),
    room_id TEXT NOT NULL CHECK(length(room_id) = 32),
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY(identity_id,operation,key)
);
CREATE INDEX http_idempotency_expiry ON http_idempotency(expires_at_ms);
