# Schema revision history

[schema.sql](../schema.sql) always defines the complete, current database schema. Update that file whenever the schema changes.

Numbered SQL files in this directory record schema changes between versions for historical reference only.
Application startup creates empty databases from `schema.sql` and does not execute these historical records.
Keep Go embedding and execution code outside this directory.
