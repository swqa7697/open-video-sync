// Package schema contains the complete, current SQLite database definition.
package schema

import _ "embed"

// Definition creates the current persistent application tables and indexes.
//
//go:embed schema.sql
var Definition string

// Version identifies the published schema supported by this binary. A schema
// release may include multiple independently numbered migrations.
const Version = 2

// Migration is one ordered change, independent of the published schema version.
type Migration struct {
	ID  int
	SQL string
}

//go:embed migrations/0001_watch_history.sql
var watchHistoryMigration string

// Migrations returns the immutable, ordered upgrades from the legacy v1 baseline.
func Migrations() []Migration {
	return []Migration{{ID: 1, SQL: watchHistoryMigration}}
}
