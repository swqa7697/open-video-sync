package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/mattn/go-isatty"
)

// Progress belongs on stderr. Remote stdout is reserved for the JSON protocol.
type progress struct {
	out         io.Writer
	terminal    bool
	color       bool
	step, total int
	title       string
	started     time.Time
	active      bool
}

func newProgress(action, host string) *progress {
	total := 6
	if action == "deploy" {
		total = 14
	} else if action == "status" || action == "restart" {
		total = 7
	}
	terminal := isatty.IsTerminal(os.Stderr.Fd()) && os.Getenv("TERM") != "dumb"
	p := &progress{out: os.Stderr, terminal: terminal, color: terminal && os.Getenv("NO_COLOR") == "", total: total}
	fmt.Fprintf(p.out, "\n%s\n", p.paint("1;36", "OVS "+action+" | "+host))
	return p
}

func (p *progress) paint(code, text string) string {
	if p.color {
		return "\x1b[" + code + "m" + text + "\x1b[0m"
	}
	return text
}

func (p *progress) begin(title string) {
	p.finish(nil)
	p.step++
	p.title, p.started, p.active = title, time.Now(), true
	fmt.Fprintf(p.out, "\n[%2d/%d] %s %s\n", p.step, p.total, p.paint("36", "RUN"), title)
}

func (p *progress) finish(err error) {
	if !p.active {
		return
	}
	p.active = false
	status, color := "OK", "32"
	if err != nil {
		status, color = "FAIL", "31"
	}
	fmt.Fprintf(p.out, "[%2d/%d] %s %s (%s)\n", p.step, p.total, p.paint(color, status), p.title, time.Since(p.started).Round(time.Millisecond))
}

func (p *progress) note(text string) {
	for _, line := range strings.Split(text, "\n") {
		fmt.Fprintf(p.out, "        %s\n", line)
	}
}

type transferProgress struct {
	p       *progress
	label   string
	total   int64
	bytes   atomic.Int64
	started time.Time
	stop    chan struct{}
	done    chan struct{}
}

func (p *progress) transfer(label string, total int64) *transferProgress {
	t := &transferProgress{p: p, label: label, total: total, started: time.Now(), stop: make(chan struct{}), done: make(chan struct{})}
	if p.terminal {
		p.note(label)
	}
	t.render(false, nil)
	go func() {
		defer close(t.done)
		interval := 10 * time.Second
		if p.terminal {
			interval = 150 * time.Millisecond
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				t.render(false, nil)
			case <-t.stop:
				return
			}
		}
	}()
	return t
}

func (t *transferProgress) reader(r io.Reader) io.Reader {
	return io.TeeReader(r, t)
}

func (t *transferProgress) Write(b []byte) (int, error) {
	t.bytes.Add(int64(len(b)))
	return len(b), nil
}

func (t *transferProgress) finish(err error) {
	close(t.stop)
	<-t.done
	t.render(true, err)
}

func (t *transferProgress) render(final bool, err error) {
	n := t.bytes.Load()
	elapsed := time.Since(t.started)
	speed := float64(n) / max(elapsed.Seconds(), 0.001)
	status := "active"
	if final {
		status = "done"
		if err != nil {
			status = "failed"
		}
	}
	detail := byteSize(n)
	bar := ""
	if t.total > 0 {
		// Reading all local bytes does not confirm remote success. Keep the last
		// percent pending until the SSH command or HTTP read has succeeded.
		percent := min(99, int(float64(n)*100/float64(t.total)))
		if final && err == nil && n == t.total {
			percent = 100
		}
		detail = fmt.Sprintf("%3d%% %s / %s", percent, detail, byteSize(t.total))
		if t.p.terminal {
			filled := percent * 16 / 100
			bar = "[" + strings.Repeat("=", filled) + strings.Repeat("-", 16-filled) + "] "
		}
	} else if t.p.terminal {
		// Docker save streams an archive of unknown size. Show activity without
		// inventing a total or buffering the archive on disk.
		position := int(elapsed/(150*time.Millisecond)) % 14
		bar = "[" + strings.Repeat("-", position) + "===" + strings.Repeat("-", 13-position) + "] "
	}
	label := t.label + ": "
	if t.p.terminal {
		label = ""
	}
	line := fmt.Sprintf("        %s%s%s | %s/s | %s | %s", label, t.p.paint("36", bar), detail, byteSize(int64(speed)), elapsed.Round(time.Second), status)
	if t.p.terminal {
		fmt.Fprint(t.p.out, "\r\x1b[2K", line)
		if final {
			fmt.Fprintln(t.p.out)
		}
	} else {
		fmt.Fprintln(t.p.out, line)
	}
}

func byteSize(n int64) string {
	value := float64(n)
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	i := 0
	for value >= 1024 && i < len(units)-1 {
		value /= 1024
		i++
	}
	return fmt.Sprintf("%.1f %s", value, units[i])
}
