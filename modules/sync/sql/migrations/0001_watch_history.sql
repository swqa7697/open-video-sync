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
