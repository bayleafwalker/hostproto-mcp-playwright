# Decisions

## ADR-0001: Chromium is the reference engine

Playwright's WebKit build cannot launch on the development host (Debian-era
sonames; see browser-workbench ADR-S5-01), and the point of this adapter is a
cheap live denominator, not engine fidelity. Chromium headless shell via
Playwright 1.62.1. The native WebKitGTK lane stays the challenger.

## ADR-0002: bundles are pinned by digest and verified twice

`hostproto-semantics.lock.json` pins a commit and a SHA-256 per bundle.
`scripts/fetch-schemas.mjs` verifies on fetch; `src/schemas.ts` verifies again
on load. A drifted bundle cannot be used even if it is on disk. Tool schemas
are the bundle objects verbatim, so what MCP advertises is what the semantics
repository published.

## ADR-0003: wire facts about MCP 2026-07-28 learned from the SDK (v2.0.0)

Recorded because the step-0 verification in hostproto-semantics was done from
the changelog; these are what the wire actually does.

1. **`resources/subscribe` does not exist on the 2026-07-28 era.** The client
   SDK refuses it (`Method 'resources/subscribe' is not supported by the
   negotiated protocol version`). A resource subscription is expressed as
   `subscriptions/listen { resourceSubscriptions: [uri, ...] }`; the server
   honours the URIs only when it declares `resources.subscribe`, and routes
   `notifications/resources/updated` to listeners whose filter contains the
   URI. `McpServer.server.sendResourceUpdated({uri})` is enough server-side.
2. **`server/discover` returns `supportedVersions`, `capabilities`,
   `instructions`.** Server identity arrives in each result's `_meta`
   (`io.modelcontextprotocol/serverInfo`), which the client exposes as
   `getServerVersion()`.
3. **`serveStdio(..., { legacy: 'reject' })`** answers a 2025-era `initialize`
   with the unsupported-version error and keeps the connection open for a
   modern opening. This adapter rejects legacy openings: the pin is real.
4. **Client pinning:** `client.setVersionNegotiation({ mode: { pin:
   '2026-07-28' } })`; `getNegotiatedProtocolVersion()` reports it.
5. `fromJsonSchema(bundle)` accepts the bundled 2020-12 schemas unchanged,
   including `anyOf` with merged `$defs`.

## ADR-0004: Tasks extension deferred

The SDK's Tasks method routing and extension-owned subscription events have
open defects (typescript-sdk #2569, #2598). No HostProto operation in
browser/v1 is long-running enough to need it. Added later behind its own
conformance gate; ordinary handles are unaffected.
