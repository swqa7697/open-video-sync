// Package checkout locates the shared root for repository automation.
package checkout

import (
	"fmt"
	"os"
	"path/filepath"
)

// EnterRoot finds versions.toml above the current working directory.
func EnterRoot() error {
	dir, err := os.Getwd()
	if err != nil {
		return err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "versions.toml")); err == nil {
			return os.Chdir(dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return fmt.Errorf("run this command from the OVS checkout")
		}
		dir = parent
	}
}
