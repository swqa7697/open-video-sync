# Open Video Sync

## Concept

Open Video Sync (OVS) is a private, self-hosted web tool that lets users watch videos together with synchronized playback.

## Requirements

- Self-Hosting: Run an independent instance on a suitable personal computer or cloud server -- not a public hosted service
- Control Only: Do not upload, store, proxy, relay, or redistribute video content through OVS
- Multiple Rooms: Support multiple viewing rooms at the same time, with independent settings and playback state
- Optional HTTPS: Keep HTTPS setup independent of core functionality
- Anonymous Identity: Let users participate without manual registratoin or sign-in -- they automatically retain their identity across visits and allow an optional display name or label
- Room Sharing: Let users create rooms, share invitation links or codes, and join shared rooms
- Host Preferences: The room creator acts as host and can configure playback permissions, synchronization behavior, and waiting rules.
- Browser Player: Provide a web player for selecting and watching supported videos within a room
- Synchronized Playback: Keep play, pause, seeking, and playback position aligned across participants according to room preferences
- Online Video Support: Support Bilibili video links in the first release, including loading and displaying danmaku; more sources (like YouTube) are planned after the first release
- Local Video Support: Let each participant select a local video file -- all participants must prepare the same video themselves (OVS does not distribute it)
- Platform Credentials: Keep video-platform login credentials and session information on the participant's device (browser) -- never send them to the OVS server
- Existing Access Rights: Participants use their own access to platform content (OVS does not grant access to restricted videos)

## Implementation Decisions

- Backend: Go
- Frontend: Vue 3, TypeScript, Vite, Pinia
- Database: SQLite
  - DDL Changes: recorded schema migrations in repo
- Packaging: Embed the built frontend into the Go application
  - All-In-One: Ship one Docker application container that serves the web UI, API, and WebSocket endpoint; no separate database service is required
  - Simple Setup: Provide a straightforward deployment and maintenance experience
- Persistent Storage: Store SQLite data in a persistent local volume mounted at /data, independent of the container lifecycle
- HTTPS: Let an optional external reverse proxy manage certificates and TLS
  - Support Caddy installed directly on the host or running in a separate container, including an existing Caddy installation
- Transport: Use WebSocket for the initial release
  - Validate control-response latency and playback skew separately under cross-region latency, jitter, and packet loss
  - Consider a datagram-based alternative if TCP head-of-line blocking prevents meeting performance targets

### Player Integration

- Player Adapters: Define a common interface for loading media, playback controls, position queries, and state events.
  - Declare optional capabilities such as playback-rate changes and buffering detection
- Local Files: Play user-selected files locally in the browser -- exchange media-matching metadata and playback state only
- Platform Sessions: Leave video-platform authentication and credentials on the participant's device
  - Exclude cookies, login tokens, and credential-bearing playback URLs from synchronization messages
- **Bilibili Validation**: Before finalizing the integration approach, verify playback control, state reporting, danmaku, and platform-session behavior in a separate proof of concept
