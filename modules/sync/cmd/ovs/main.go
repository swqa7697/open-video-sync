// Command ovs runs the OVS development framework with embedded web assets.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/helper"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/history"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/storage"
	transport "github.com/swqa7697/open-video-sync/modules/sync/internal/transport/http"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/transport/ws"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/web"
)

var (
	version = "0.0.0-dev"
	channel = "dev"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Printf("ovs %s (%s)\n", version, channel)
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "migrate" {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if err := migrate(ctx, os.Getenv); err != nil {
			fmt.Fprintln(os.Stderr, "database migration failed:", err)
			os.Exit(1)
		}
		fmt.Println("Database schema is current.")
		return
	}
	if len(os.Args) > 1 && !(len(os.Args) == 2 && os.Args[1] == "healthcheck") {
		fmt.Fprintln(os.Stderr, "usage: ovs [version|healthcheck|migrate]")
		os.Exit(2)
	}
	cfg, err := environmentConfig()
	if err != nil {
		slog.Error("configuration invalid", "error", err)
		os.Exit(1)
	}
	if len(os.Args) == 2 {
		if err := healthcheck(cfg); err != nil {
			fmt.Fprintln(os.Stderr, "OVS is not ready")
			os.Exit(1)
		}
		return
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.logLevel}))
	slog.SetDefault(logger)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, cfg, logger); err != nil {
		logger.Error("process failed", "error", err)
		os.Exit(1)
	}
}

func migrate(ctx context.Context, getenv func(string) string) error {
	directory := getenv("OVS_DATA_DIR")
	if directory == "" {
		directory = "/data"
	}
	return storage.Migrate(ctx, directory)
}

func run(ctx context.Context, cfg config, logger *slog.Logger) (err error) {
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	store, err := storage.Open(startup, cfg.dataDir)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, store.Close()) }()
	engine, err := store.SQLiteVersion(startup)
	if err != nil {
		return fmt.Errorf("read SQLite engine version: %w", err)
	}
	frontend, err := web.Handler()
	if err != nil {
		return err
	}
	webRelease, err := web.Release()
	if err != nil {
		return err
	}
	helperVersion, err := helper.Version()
	if err != nil {
		return err
	}
	helperHandler, err := helper.Handler(cfg.origin.String())
	if err != nil {
		return err
	}
	var stopping atomic.Bool
	ready := func(ctx context.Context) error {
		if stopping.Load() {
			return errors.New("shutting down")
		}
		return store.Ready(ctx)
	}
	roomService, err := rooms.NewService(store, time.Now, rand.Reader, cfg.roomLimits)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, roomService.Close()) }()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	if err := identities.Initialize(startup); err != nil {
		return err
	}
	personalHistory, err := history.New(startup, store, time.Now, identities.Validate)
	if err != nil {
		return err
	}
	cleanupCtx, stopCleanup := context.WithCancel(ctx)
	cleanupDone := make(chan struct{})
	go func() { defer close(cleanupDone); identities.RunCleanup(cleanupCtx) }()
	defer func() { stopCleanup(); <-cleanupDone }()
	api := transport.NewAPI(cfg.origin.String(), identities)
	api.WithHistory(personalHistory)
	api.WithVersions(transport.Versions{
		Sync: version, Web: webRelease.Version, Helper: helperVersion,
		Image: webRelease.Image, Release: webRelease.Release,
		Commit: webRelease.Commit, Dirty: webRelease.Dirty, Tag: webRelease.Tag,
	})
	api.TrustedProxies = cfg.trustedProxies
	api.WithRooms(roomService)
	sockets := ws.NewHandler(cfg.origin.String(), identities, roomService)
	server := &http.Server{
		Handler:           transport.NewHandler(cfg.origin.Host, ready, frontend, api, sockets, helperHandler),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       time.Minute,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	listener, err := net.Listen("tcp", cfg.listenAddr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	logger.Info("server ready", "version", version, "channel", channel, "sqlite", engine, "listen", listener.Addr().String())
	select {
	case err := <-served:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve HTTP: %w", err)
	case <-ctx.Done():
		stopping.Store(true)
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		httpStopped := make(chan error, 1)
		socketsStopped := make(chan error, 1)
		go func() { httpStopped <- server.Shutdown(shutdown) }()
		go func() { socketsStopped <- sockets.Shutdown(shutdown) }()
		roomErr := roomService.CloseContext(shutdown)
		shutdownErr := errors.Join(roomErr, <-httpStopped, <-socketsStopped)
		if shutdownErr != nil {
			shutdownErr = errors.Join(shutdownErr, server.Close())
		}
		serveErr := <-served
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		return errors.Join(shutdownErr, serveErr)
	}
}

func healthcheck(cfg config) error {
	host, port, _ := net.SplitHostPort(cfg.listenAddr)
	switch host {
	case "", "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://" + net.JoinHostPort(host, port) + "/health/ready")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return errors.New("not ready")
	}
	return nil
}
