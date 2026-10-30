CREATE TABLE room_media (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
    descriptor TEXT NOT NULL CHECK(json_valid(descriptor))
);
CREATE TABLE playback_checkpoints (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    position_ms INTEGER NOT NULL CHECK(position_ms BETWEEN 0 AND 604800000),
    phase TEXT NOT NULL CHECK(phase IN ('paused','playing','waiting','ended')),
    saved_at_ms INTEGER NOT NULL
);
CREATE TABLE command_results (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    identity_id TEXT NOT NULL REFERENCES identities(id),
    command_id TEXT NOT NULL CHECK(length(command_id)=32),
    epoch TEXT NOT NULL CHECK(length(epoch)=32),
    digest TEXT NOT NULL CHECK(length(digest)=64),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY(room_id,identity_id,command_id)
);
CREATE INDEX command_results_expiry ON command_results(expires_at_ms);
