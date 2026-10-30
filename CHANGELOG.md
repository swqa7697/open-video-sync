# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Add browser-local Bilibili AVC/AAC playback and danmaku through an instance-scoped Tampermonkey helper. Each participant uses their own platform access. Support exact multipart matching, room controls and waiting, bounded streaming with local expiry refresh, and local comment visibility, density, and text size. Helper failures show grouped next steps, and a participant without platform access appears to others as Platform access unavailable.
- Add local synchronized viewing with browser-only file selection, sampled media matching over HTTP, authenticated room controls, automatic playback takeover between pages, clock calibration, drift correction, and reconnect. On a high-latency link, the page states that synchronization may drift, and waits and room controls stay available. Support startup and buffering waits that name the participants being waited for, ready late-join catch-up, and controller permission during host absence, with the reason when room controls are unavailable. Playback restarts paused at zero; persistent-write failures leave existing playback available.
- Add persistent anonymous identities and private rooms with reusable invitation links/codes, host/everyone controls and wait-for-everyone preferences, member removal, leave, closure, immediate session revocation, and bounded expired-session cleanup. Support direct HTTP with session/CSRF protection and isolated browser profiles. Keyboard operation keeps focus on the current task, status text is readable, server status distinguishes unreachable from unable to save, and room endings, connection, storage, and session failures each give their own recovery step.
- Add a development template with an embedded Vue shell, HTTP health checks, validated configuration, and SQLite migrations with exclusive data-directory ownership.
- Add development, validation, and release commands, plus a non-root application container with persistent `/data` storage and optional external Caddy HTTPS deployment examples. Optional trusted-proxy CIDRs keep per-client request limits behind a reverse proxy.
