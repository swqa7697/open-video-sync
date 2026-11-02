// Package versions reads the repository's module release manifest.
package versions

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

var entry = regexp.MustCompile(`^(sync|web|helper)\s*=\s*"((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))"$`)

// Parse accepts the single versions table and rejects missing or duplicate modules.
func Parse(raw string) (map[string]string, error) {
	result := make(map[string]string)
	table := false
	for line := range strings.SplitSeq(raw, "\n") {
		line, _, _ = strings.Cut(line, "#")
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if line == "[versions]" && !table {
			table = true
			continue
		}
		match := entry.FindStringSubmatch(line)
		if !table || match == nil || result[match[1]] != "" {
			return nil, fmt.Errorf("invalid versions.toml: expected one stable version per module")
		}
		result[match[1]] = match[2]
	}
	if len(result) != 3 {
		return nil, fmt.Errorf("versions.toml must define sync, web, and helper")
	}
	return result, nil
}

// Read loads and validates a module release manifest.
func Read(path string) (map[string]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(string(raw))
}

// Replace updates one module while retaining comments and unrelated entries.
func Replace(raw, module, value string) (string, error) {
	if _, err := Parse(raw); err != nil {
		return "", err
	}
	if module != "sync" && module != "web" && module != "helper" {
		return "", fmt.Errorf("unknown module %q", module)
	}
	pattern := regexp.MustCompile(`(?m)^(\s*` + module + `\s*=\s*")[^"]*(")`)
	updated := pattern.ReplaceAllString(raw, "${1}"+value+"${2}")
	if _, err := Parse(updated); err != nil {
		return "", err
	}
	return updated, nil
}
