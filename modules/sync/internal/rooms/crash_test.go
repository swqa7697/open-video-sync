package rooms_test

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/storage"
)

func TestCrashRestoresSelectionAtZeroWithFreshRuntime(t *testing.T) {
	if os.Getenv("OVS_CRASH_CHILD") == "1" {
		crashChild(t)
		return
	}
	ctx := context.Background()
	directory := t.TempDir()
	store, err := storage.Open(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	host, token, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	settings := contracts.DefaultSettings()
	settings.WaitForAll = false
	created, err := service.Create(ctx, host, key(t), "Crash", settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestCrashRestoresSelectionAtZeroWithFreshRuntime$")
	child.Env = append(os.Environ(), "OVS_CRASH_CHILD=1", "OVS_CRASH_DIRECTORY="+directory, "OVS_CRASH_TOKEN="+token, "OVS_CRASH_ROOM="+created.Snapshot.RoomID)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	child.Stderr = &stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			ready <- scanner.Text()
		} else {
			ready <- ""
		}
	}()
	var state struct {
		Epoch, CommandID string
		Revision         int64
	}
	select {
	case line := <-ready:
		if err := json.Unmarshal([]byte(line), &state); err != nil {
			t.Fatal("crash child failed", err, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("crash child did not publish applied state")
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	store, err = storage.Open(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service, err = rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	snap, err := service.Snapshot(ctx, host, created.Snapshot.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Epoch == state.Epoch || snap.Playback.Phase != "paused" || snap.Playback.PositionMs != 0 || snap.Playback.DesiredPlaying || snap.Revision != 1 || snap.Barrier != nil {
		t.Fatal("crash recovery advanced or lost committed position", snap)
	}
	conn, err := service.Connect(ctx, host, snap.RoomID, &sink{})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Handle(ctx, conn, contracts.ClientFrame{Type: "playback.command", Action: "play", CommandID: state.CommandID, Epoch: state.Epoch, MediaGeneration: 1, ExpectedRevision: state.Revision}); err != contracts.Failure("stale_state") {
		t.Fatal("precrash intent accepted", err)
	}

}

func crashChild(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, os.Getenv("OVS_CRASH_DIRECTORY"))
	if err != nil {
		t.Fatal(err)
	}
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	host, err := identities.Authenticate(ctx, os.Getenv("OVS_CRASH_TOKEN"))
	if err != nil {
		t.Fatal(err)
	}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	var clock atomic.Int64
	service.Monotonic = clock.Load
	snap, err := service.Snapshot(ctx, host, os.Getenv("OVS_CRASH_ROOM"))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := service.Connect(ctx, host, snap.RoomID, &sink{})
	if err != nil {
		t.Fatal(err)
	}
	send := func(f contracts.ClientFrame) string {
		t.Helper()
		f.CommandID = key(t)
		f.Epoch = snap.Epoch
		f.MediaGeneration = snap.MediaGeneration
		f.ExpectedRevision = snap.Revision
		if err := service.Handle(ctx, conn, f); err != nil {
			t.Fatal(err)
		}
		snap, err = service.Snapshot(ctx, host, snap.RoomID)
		if err != nil {
			t.Fatal(err)
		}
		return f.CommandID
	}
	send(contracts.ClientFrame{Type: "media.select", Media: contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("a", 64), SizeBytes: 1, DurationMs: 60000}})
	send(contracts.ClientFrame{Type: "playback.command", Action: "play"})
	clock.Store(11000)
	commandID := send(contracts.ClientFrame{Type: "playback.command", Action: "seek", PositionMs: 20000})
	clock.Store(15000) // Runtime progress must be discarded after the kill.
	b, _ := json.Marshal(struct {
		Epoch, CommandID string
		Revision         int64
	}{snap.Epoch, commandID, snap.Revision})
	fmt.Println(string(b))
	select {} // The parent terminates the process without calling Close.
}
