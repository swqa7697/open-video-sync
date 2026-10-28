# Feature boundaries

`identity/` owns profile editing and explicit identity reset. `rooms/` owns membership, sharing, and host-management views.
The application shell owns request cancellation and uncertain HTTP retries. Serializable Pinia state keeps credentials in memory only.
Keep timing and adapter ownership outside Vue rendering when the player is implemented.
