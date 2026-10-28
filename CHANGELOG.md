# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Add local synchronized viewing with browser-only file selection, sampled media matching over HTTP, authenticated room controls, playback-tab ownership, clock calibration, drift correction, and reconnect. Support startup and buffering waits, late-join preferences, participant exclusions, host-loss pause, periodic checkpoints, and paused crash/storage recovery. Bilibili remains in development.
- Add persistent anonymous identities and private rooms with expiring invitation links/codes, saved host preferences, member removal, leave, closure, immediate session revocation, and bounded inactive-data cleanup. Support direct HTTP with session/CSRF protection and isolated browser profiles.
- Add a development template with an embedded Vue shell, HTTP health checks, validated configuration, and SQLite migrations with exclusive data-directory ownership.
- Add development, validation, and release commands, plus a non-root application container with persistent `/data` storage and optional external Caddy deployment examples.
