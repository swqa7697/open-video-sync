// Command release implements checkout-only version, release commit, and tag tooling.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
)

type app struct {
	ctx      context.Context
	root     string
	in       io.Reader
	out      io.Writer
	terminal bool
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	info, err := os.Stdin.Stat()
	a := app{ctx: ctx, root: ".", in: os.Stdin, out: os.Stdout, terminal: err == nil && info.Mode()&os.ModeCharDevice != 0}
	if err := a.execute(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

func (a *app) execute(args []string) error {
	root, err := a.git("rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	a.root = strings.TrimSpace(root)
	switch {
	case (len(args) == 2 || len(args) == 3) && args[0] == "bump":
		return a.bump(args[1], args[2:]...)
	case len(args) == 1 && args[0] == "commit":
		return a.commit(false)
	case len(args) == 2 && args[0] == "commit" && args[1] == "--yes":
		return a.commit(true)
	case len(args) == 1 && args[0] == "tag":
		return a.tag()
	default:
		return errors.New("usage: release {bump major|minor|patch [sync|web|helper] | commit [--yes] | tag}")
	}
}

func (a *app) git(args ...string) (string, error) {
	cmd := exec.CommandContext(a.ctx, "git", args...)
	cmd.Dir = a.root
	var stderr strings.Builder
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return string(raw), nil
}

func (a *app) confirm(prompt, expected string) error {
	if !a.terminal {
		return errors.New("confirmation requires an interactive terminal; release-commit also accepts YES=1 after approval")
	}
	fmt.Fprint(a.out, prompt)
	answer, err := bufio.NewReader(a.in).ReadString('\n')
	if err != nil {
		return fmt.Errorf("read confirmation: %w", err)
	}
	if strings.TrimSpace(answer) != expected {
		return errors.New("confirmation did not match; aborted")
	}
	return nil
}
