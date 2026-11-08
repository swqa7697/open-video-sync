# Database migrations

[schema.sql](../schema.sql) always defines the complete, current database schema. Update that file whenever the schema changes.

Numbered SQL files upgrade existing databases during the explicit `ovs migrate` deployment step. Keep released migrations immutable: the database ledger records each `migration_id`, SHA-256 checksum, and completion time. Add each consecutive ID to the ordered registry in `../embed.go`.

Migration IDs and the release-level schema version are independent. One schema release can include multiple incremental migrations, and the pending set is selected only from the applied ledger prefix. For example, schema version 2 currently includes migration `0001_watch_history.sql`; its migration ID is 1, not 2. Set the target release schema version separately from migration numbering.

Fresh databases use `schema.sql` directly and record its included migrations without executing historical SQL. The existing version-1 schema is the supported baseline without a ledger. The migration runner creates the ledger infrastructure before executing feature migrations. Deployment applies all pending migrations and ledger changes in one transaction, then sets `user_version` to the target schema release version before committing. Failed batches leave both application data and ledger/version metadata unchanged.

Normal application startup initializes empty databases or validates both the current schema version and complete expected ledger. Startup never executes migrations; even a database with the current schema version requires deployment migration when its known ledger prefix is incomplete. Keep Go embedding and execution code outside this directory.
