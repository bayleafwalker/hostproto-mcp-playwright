# hostproto-mcp-playwright

The HostProto reference adapter: a headless Playwright (Chromium) host exposed
through **MCP 2026-07-28**, pinned. Semantics come from
[hostproto-semantics](https://github.com/bayleafwalker/hostproto-semantics);
this repository owns only the browser, the MCP surface, the handle registry,
validation, and the adapter's own tests.

## What it does

| MCP surface | HostProto object |
| --- | --- |
| `hostproto_context_create` → `structuredContent` | `handles/v1` (host, context, surface; writer fence) |
| `hostproto_surface_observe` → `structuredContent` + `resource_link`s | `observation/v1` — revision, cursor, explicit loss; screenshots and raw copies as resources |
| `hostproto_surface_act` (input **is** the `intent/v1` bundle) | `receipt/v1` — attempted/accepted/executed/verified, outcome incl. `unknown` |
| `hostproto_surface_await` | host-side wait over the recorded event stream |
| `hostproto_capabilities` | `capability-profile/v1` — `runtime` only for what this process executed |
| `hostproto://surface/{id}/state` resource | subscribable via `subscriptions/listen { resourceSubscriptions: [uri] }` |
| any error → `isError` + `structuredContent` | `error/v1` with `host_invoked` |

Targets carry the revision they were observed at; a target from an earlier
revision is rejected as `target_invalidated` **before** the engine is touched.
Declared preconditions are checked the same way.

## Schemas are pinned, not copied

`hostproto-semantics.lock.json` names a commit and a SHA-256 per bundle.
`npm run schemas` fetches `bundled/*.json` at that commit into the gitignored
`schemas/` and refuses any digest mismatch; `src/schemas.ts` re-verifies at
load. Tool `inputSchema`/`outputSchema` are those bundles verbatim (composed
with `anyOf` for receipt-or-error), and every emitted object is validated
against them before it leaves the process. There are no hand-written
TypeScript interfaces for HostProto types.

## Not in step 2, deliberately

- `io.modelcontextprotocol/tasks` — the SDK's Tasks routing has open defects; added later behind its own conformance gate.
- persistent profiles, uploads, downloads, permissions — the browser/v1 profile here is the minimum that exercises every HostProto semantic.
- WebKit — this host cannot launch Playwright's WebKit build; Chromium is the reference engine, and the native WebKitGTK lane in browser-workbench remains the challenger.

## Run

```sh
npm ci
npx playwright install chromium-headless-shell
npm run schemas
npm test          # real client ↔ real server over stdio ↔ real Chromium
npm start         # stdio server
```
