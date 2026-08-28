# Agent guidance

- Never copy a schema in. Change `hostproto-semantics.lock.json` (commit + digests) and run `npm run schemas`.
- Never hand-write a TypeScript interface for a HostProto type; validate against the bundle with `assertValid`.
- Host semantics (revision, cursor, target invalidation, preconditions, receipts, deviations) live in `src/host.ts`. `src/server.ts` is projection only.
- Every error leaving a tool is `error/v1` with an honest `host_invoked`.
- Tests are wire-level (`tests/adapter.test.ts`): real client, real stdio server, real Chromium. Keep them that way.
- Record every wire fact learned about MCP 2026-07-28 or the SDK in `docs/DECISIONS.md` with the SDK version.
