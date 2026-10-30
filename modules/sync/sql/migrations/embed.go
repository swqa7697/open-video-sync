// Package migrations contains the ordered, immutable SQLite migrations.
package migrations

import "embed"

// Files contains the SQL migrations shipped with this binary.
//
//go:embed *.sql
var Files embed.FS
