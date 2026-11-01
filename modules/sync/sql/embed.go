// Package schema contains the complete, current SQLite database definition.
package schema

import _ "embed"

// Definition creates the current persistent application tables and indexes.
//
//go:embed schema.sql
var Definition string
