# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-22

### Added

- Trash page rendered as a `main` panel keyed `trash`, reachable from three
  places: the sidebar's global panel row, the hover control on every Session
  row, and the Session's `…` menu (which preselects that Session).
- Listing of every stored Session with title, size, update time, working
  directory, and state tags (`live` / `archived` / `derived`).
- Batch selection, select-all, search filter, and per-item result reporting.
- **Delete file**: atomic rename of the canonical log to a
  `.trash-deleted-<stamp>` marker, then directory removal, projection-cache
  cleanup, and Workspace bookkeeping detach.
- **Clear content**: rewrite the log with its header record only, in the
  original encoding (zstd or plaintext), verified by re-decoding, with backup
  restore on failure.
- Forced operations on a live Session: `cancel({ kind: 'user' })`, wait for
  quiescence, then proceed; the UI switches away from the Session it is
  showing.
- Tombstone sweep: a Session deleted while its Agent stayed attached is watched
  for one hour so a recreated log is removed instead of lingering unreadable.
- Cascade support for derived Sessions behind an explicit `cascade: true`.
- Loopback same-origin guard on all three routes.
- Offline test suite: host end-to-end over real log samples, client wiring
  smoke, and a React-stub render smoke covering seven page states.

### Notes

- Clearing is refused for derived Sessions (forks, subagent children), whose
  header promises an inherited seed prefix.
- The compressed-log rewrite requires `zlib.zstdCompressSync` (Node ≥ 22.15).
