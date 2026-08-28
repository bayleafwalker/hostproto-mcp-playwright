// The MCP surface. Tool input and output schemas are the pinned bundles,
// verbatim; results are `structuredContent`; artifacts are resources; surface
// state is a subscribable resource. No host semantics live here.
import { McpServer, ResourceTemplate, fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import { PlaywrightHost, HostProtoError, PROJECTIONS, type Artifact } from './host.js';
import { anyOf, toolSchema, pinnedCommit, assertValid } from './schemas.js';

export const SERVER_INFO = { name: 'hostproto-mcp-playwright', version: '0.0.1' };
export const PROTOCOL_REVISION = '2026-07-28';

function stateUri(surface: string) { return `hostproto://surface/${surface}/state`; }

export function createServer(host: PlaywrightHost): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } },
    instructions: `HostProto browser/v1 adapter on Playwright. Schemas pinned to hostproto-semantics@${pinnedCommit.slice(0, 12)}. Create a context, then observe/act/await on the surface handle. Targets are valid for one revision only.`,
  });
  const artifacts = new Map<string, Artifact>();

  host.onSurfaceChanged(surface => { void server.server.sendResourceUpdated({ uri: stateUri(surface) }).catch(() => {}); });

  const ok = (structuredContent: Record<string, unknown>, extra: CallToolResult['content'] = []): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }, ...extra], structuredContent, isError: false,
  });
  const fail = (error: unknown): CallToolResult => {
    const object = error instanceof HostProtoError ? error.toObject()
      : { schema_version: 'hostproto.error/v1', code: 'host_failed', message: String((error as Error).message ?? error).slice(0, 1024), host_invoked: true, data: {} };
    assertValid('error', object);
    return { content: [{ type: 'text', text: JSON.stringify(object) }], structuredContent: object, isError: true };
  };
  const run = async (fn: () => Promise<CallToolResult>) => { try { return await fn(); } catch (error) { return fail(error); } };

  server.registerTool('hostproto_context_create', {
    title: 'Create a browser context',
    description: 'Mint host, context and surface handles. Only ephemeral profiles. Returns hostproto.handles/v1.',
    inputSchema: fromJsonSchema({ type: 'object', additionalProperties: false, properties: {
      client: { type: 'object', properties: { id: { type: 'string' } } },
      profile: { type: 'object', properties: { mode: { enum: ['ephemeral'] } } },
      viewport: { type: 'object', required: ['width', 'height'], properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } } } } }),
    outputSchema: fromJsonSchema(anyOf('handles', 'error')),
  }, async (args) => run(async () => ok(await host.createContext(args as never))));

  server.registerTool('hostproto_context_close', {
    title: 'Close a context', description: 'Closes the context and every surface in it. Handles expire.',
    inputSchema: fromJsonSchema({ type: 'object', required: ['context'], additionalProperties: false, properties: { context: { type: 'string', minLength: 1 } } }),
  }, async (args) => run(async () => ok(await host.closeContext((args as { context: string }).context))));

  server.registerTool('hostproto_surface_observe', {
    title: 'Observe a surface',
    description: `Returns hostproto.observation/v1 with a revision and cursor. Projections: ${PROJECTIONS.join(', ')}. Screenshots and lossy raw copies become resources, linked in content.`,
    inputSchema: fromJsonSchema({ type: 'object', required: ['surface'], additionalProperties: false, properties: {
      surface: { type: 'string', minLength: 1 }, projections: { type: 'array', items: { enum: [...PROJECTIONS] }, minItems: 1 },
      since: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 512 } } }),
    outputSchema: fromJsonSchema(anyOf('observation', 'error')),
  }, async (args) => run(async () => {
    const { observation, artifacts: produced } = await host.observe(args as never);
    for (const artifact of produced) artifacts.set(artifact.uri, artifact);
    return ok(observation, produced.map(a => ({ type: 'resource_link' as const, uri: a.uri, name: a.uri.split('/').pop()!, mimeType: a.mediaType })));
  }));

  server.registerTool('hostproto_surface_act', {
    title: 'Act on a surface',
    description: 'Execute one hostproto.intent/v1 exactly once and return hostproto.receipt/v1. A target from an earlier revision is rejected (target_invalidated) before the host is touched; declared preconditions likewise.',
    inputSchema: fromJsonSchema(toolSchema('intent')),
    outputSchema: fromJsonSchema(anyOf('receipt', 'error')),
  }, async (args) => run(async () => ok(await host.act(args as Record<string, unknown>))));

  server.registerTool('hostproto_surface_await', {
    title: 'Wait for a surface condition',
    description: 'Host-side wait over the recorded event stream. Conditions: load_state=idle, url, title, revision, event_kind. deadline_exceeded reports the unsatisfied conditions.',
    inputSchema: fromJsonSchema({ type: 'object', required: ['surface', 'conditions'], additionalProperties: false, properties: {
      surface: { type: 'string', minLength: 1 }, deadline_ms: { type: 'integer', minimum: 1, maximum: 300000 },
      conditions: { type: 'array', minItems: 1, items: { type: 'object', required: ['kind', 'equals'], properties: { kind: { enum: ['load_state', 'url', 'title', 'revision', 'event_kind'] }, equals: {} } } } } }),
  }, async (args) => run(async () => ok(await host.await(args as never))));

  server.registerTool('hostproto_capabilities', {
    title: 'Capability profile', description: 'hostproto.capability-profile/v1 for browser/v1. Verification is runtime only for capabilities this process has executed.',
    inputSchema: fromJsonSchema({ type: 'object', additionalProperties: false }),
    outputSchema: fromJsonSchema(toolSchema('capability-profile')),
  }, async () => run(async () => ok(host.capabilityProfile())));

  server.registerResource('surface-state', new ResourceTemplate('hostproto://surface/{surface}/state', {
    list: async () => ({ resources: host.listSurfaces().map(id => ({ uri: stateUri(id), name: `surface ${id} state`, mimeType: 'application/json' })) }),
  }), { title: 'Surface state', description: 'Live url/title/lifecycle/revision/cursor of a surface. Subscribe for change notifications.', mimeType: 'application/json' },
  async (uri, variables) => {
    const state = await host.readSurfaceState(String(variables.surface));
    if (!state) throw new HostProtoError('handle_expired', 'unknown surface', false);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(state) }] };
  });

  server.registerResource('artifact', new ResourceTemplate('hostproto://surface/{surface}/{kind}/{name}', { list: undefined }),
    { title: 'Evidence artifact', description: 'Screenshots and raw observations, content-addressed in the observation that produced them.' },
    async (uri) => {
      const artifact = artifacts.get(uri.href);
      if (!artifact) throw new HostProtoError('handle_expired', 'unknown artifact', false);
      return { contents: [artifact.mediaType.startsWith('image/')
        ? { uri: uri.href, mimeType: artifact.mediaType, blob: artifact.bytes.toString('base64') }
        : { uri: uri.href, mimeType: artifact.mediaType, text: artifact.bytes.toString('utf8') }] };
    });

  return server;
}
