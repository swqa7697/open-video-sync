# Feature boundaries

`identity/` owns profile editing and explicit identity reset. `rooms/` owns membership, sharing, and host-management views.
The application shell owns request cancellation and uncertain HTTP retries. Serializable Pinia state keeps credentials in memory only.
Player timers and adapter ownership stay outside serializable stores. The room view exposes controller permission and wait for everyone.
Sharing retrieves reusable host-only invitations. Replaced pages dispose playback and require an explicit reload to take over again.
