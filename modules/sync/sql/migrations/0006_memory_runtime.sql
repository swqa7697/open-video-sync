-- Preserve durable records while discarding the previous playback runtime.
UPDATE rooms SET settings=json_object('v',2,'value',json_object(
    'controllers',json_extract(settings,'$.value.controllers'),
    'waitForAll',json(CASE WHEN json_extract(settings,'$.value.waitMode')='all' THEN 'true' ELSE 'false' END)));
DROP TABLE playback_checkpoints;
DROP TABLE command_results;
DROP TABLE http_idempotency;
DROP TABLE storage_probe;
DROP INDEX rooms_activity;
ALTER TABLE rooms DROP COLUMN revision;
ALTER TABLE rooms DROP COLUMN last_active_at_ms;
ALTER TABLE identities DROP COLUMN last_seen_at_ms;
ALTER TABLE room_media DROP COLUMN generation;
DROP INDEX invitations_expiry;
ALTER TABLE room_invitations ADD COLUMN link_secret TEXT;
ALTER TABLE room_invitations ADD COLUMN code TEXT;
-- Null values identify legacy hash-only invitations. Preserve their verifiers and expiry.
