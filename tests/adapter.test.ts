// Wire-level: a real MCP 2026-07-28 client over stdio to the real server
// process, driving a real Chromium against a loopback fixture. Nothing is
// mocked between the client and the engine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { validator } from '../src/schemas.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
let fixture: Server; let base: string;
let client: Client; let transport: StdioClientTransport;
const updated: string[] = [];

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, sc: result.structuredContent as Record<string, any> };
};

beforeAll(async () => {
  fixture = createHttpServer(async (req, res) => {
    const file = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'index.html';
    try { const body = await readFile(FIXTURES + file); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const address = fixture.address() as { port: number };
  base = `http://127.0.0.1:${address.port}/`;

  transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/stdio.ts'], cwd: fileURLToPath(new URL('..', import.meta.url)), stderr: 'pipe' });
  client = new Client({ name: 'hostproto-conformance', version: '0.0.1' });
  client.setVersionNegotiation({ mode: { pin: '2026-07-28' } });
  client.setNotificationHandler('notifications/resources/updated', n => { updated.push(n.params.uri); });
  await client.connect(transport);
});

afterAll(async () => { await client?.close().catch(() => {}); await new Promise<void>(r => fixture?.close(() => r())); });

describe('wire behaviour on 2026-07-28', () => {
  it('negotiates the pinned revision and answers server/discover', async () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const discovered = await client.discover();
    expect(discovered.supportedVersions).toContain('2026-07-28');
    expect(client.getServerVersion()?.name).toBe('hostproto-mcp-playwright');
    expect(discovered.capabilities?.resources?.subscribe).toBe(true);
  });

  it('publishes the pinned bundles as tool schemas with no remote $ref', async () => {
    const tools = (await client.listTools()).tools;
    const act = tools.find(t => t.name === 'hostproto_surface_act')!;
    expect(act.inputSchema.properties).toHaveProperty('kind');
    expect(JSON.stringify(act)).not.toMatch(/hostproto\.invalid/);
    expect(act.outputSchema).toBeDefined();
  });
});

describe('HostProto semantics on a real engine', () => {
  let surface: string; let context: string; let targets: any[];

  it('mints handles', async () => {
    const { sc, isError } = await call('hostproto_context_create', { client: { id: 'conformance' }, viewport: { width: 1024, height: 768 } });
    expect(isError).toBe(false);
    expect(validator('handles')(sc)).toBe(true);
    surface = sc.surface.id; context = sc.context.id;
    expect(sc.surface.lifecycle).toBe('open');
  });

  it('navigates with a receipt whose revision advanced and notifies the subscribed state resource', async () => {
    // 2026-07-28: `resources/subscribe` is gone; the resource URIs ride the
    // `subscriptions/listen` filter and the server routes updates by URI.
    const listening = await client.listen({ resourceSubscriptions: [`hostproto://surface/${surface}/state`] });
    const { sc } = await call('hostproto_surface_act', { schema_version: 'hostproto.intent/v1', action_id: 'a-1', surface, kind: 'navigate', params: { url: `${base}index.html` } });
    expect(validator('receipt')(sc)).toBe(true);
    expect(sc.outcome).toBe('completed');
    expect(sc.revision_after).toBeGreaterThan(sc.revision_before);
    await call('hostproto_surface_await', { surface, conditions: [{ kind: 'load_state', equals: 'idle' }, { kind: 'title', equals: 'HostProto Fixture Index' }], deadline_ms: 10000 });
    await new Promise(r => setTimeout(r, 200));
    expect(updated).toContain(`hostproto://surface/${surface}/state`);
    await listening.close();
  });

  it('observes a revisioned, cursored observation with targets, console and a screenshot resource', async () => {
    const result = await call('hostproto_surface_observe', { surface, projections: ['state', 'targets', 'console', 'screenshot'] });
    const { sc } = result;
    expect(validator('observation')(sc)).toBe(true);
    expect(sc.data.state.title).toBe('HostProto Fixture Index');
    expect(sc.data.console[0].payload.text).toBe('fixture console record');
    targets = sc.data.targets;
    expect(targets[0].role).toBe('link');
    const link = result.content.find(c => c.type === 'resource_link') as { uri: string };
    const read = await client.readResource({ uri: link.uri });
    expect((read.contents[0] as { blob: string }).blob.length).toBeGreaterThan(100);
    expect(sc.data.screenshot.ref).toMatch(/^sha256:/);
  });

  it('explicit loss when bounded', async () => {
    const { sc } = await call('hostproto_surface_observe', { surface, projections: ['state', 'dom', 'network'], max_bytes: 700 });
    expect(sc.bounded.lossy).toBe(true);
    expect(sc.bounded.raw_ref).toMatch(/^sha256:/);
    expect(Object.keys(sc.bounded.omitted).length).toBeGreaterThan(0);
  });

  it('rejects a failed precondition before touching the host', async () => {
    const { sc, isError } = await call('hostproto_surface_act', { schema_version: 'hostproto.intent/v1', action_id: 'a-2', surface, kind: 'javascript', params: { value: 'document.title' },
      preconditions: { schema_version: 'hostproto.precondition/v1', surface, assertions: [{ field: 'title', equals: 'Wrong' }] } });
    expect(isError).toBe(true);
    expect(validator('error')(sc)).toBe(true);
    expect(sc.code).toBe('precondition_failed');
    expect(sc.host_invoked).toBe(false);
  });

  it('clicks a fresh target, then rejects the same target after the revision moved', async () => {
    const click = await call('hostproto_surface_act', { schema_version: 'hostproto.intent/v1', action_id: 'a-3', surface, kind: 'click', target: targets[0] });
    expect(click.sc.outcome).toBe('completed');
    await call('hostproto_surface_await', { surface, conditions: [{ kind: 'url', equals: `${base}next.html` }, { kind: 'load_state', equals: 'idle' }], deadline_ms: 10000 });
    const stale = await call('hostproto_surface_act', { schema_version: 'hostproto.intent/v1', action_id: 'a-4', surface, kind: 'click', target: targets[0] });
    expect(stale.isError).toBe(true);
    expect(stale.sc.code).toBe('target_invalidated');
    expect(stale.sc.host_invoked).toBe(false);
  });

  it('holds a script dialog open until a declared decision, and rejects a duplicate', async () => {
    await call('hostproto_surface_await', { surface, conditions: [{ kind: 'event_kind', equals: 'dialog.opened' }], deadline_ms: 10000 });
    const { sc } = await call('hostproto_surface_observe', { surface, projections: ['dialogs'] });
    const token = sc.data.dialogs[0].token;
    expect(sc.data.dialogs[0].status).toBe('pending');
    const first = await call('hostproto_surface_act', { schema_version: 'hostproto.intent/v1', action_id: 'a-5', surface, kind: 'dialog.resolve', decision_token: token, params: { decision: 'dismiss' } });
    expect(first.sc.effects[0].decision).toBe('dismiss');
    const dup = await call('hostproto_surface_act', { schema_version: 'hostproto.intent/v1', action_id: 'a-6', surface, kind: 'dialog.resolve', decision_token: token, params: { decision: 'accept' } });
    expect(dup.sc.code).toBe('precondition_failed');
  });

  it('reports deadline_exceeded with the unsatisfied conditions', async () => {
    const { sc, isError } = await call('hostproto_surface_await', { surface, conditions: [{ kind: 'title', equals: 'Never' }], deadline_ms: 50 });
    expect(isError).toBe(true);
    expect(sc.code).toBe('deadline_exceeded');
    expect(sc.data.unsatisfied[0].equals).toBe('Never');
  });

  it('earns runtime verification only for what ran', async () => {
    const { sc } = await call('hostproto_capabilities');
    expect(validator('capability-profile')(sc)).toBe(true);
    expect(sc.capabilities['act.click'].verification).toBe('runtime');
    expect(sc.capabilities['act.type'].verification).toBe('source-audit');
    expect(sc.capabilities['observe.screenshot'].runtime_executions).toBe(1);
  });

  it('expires handles on close', async () => {
    const closed = await call('hostproto_context_close', { context });
    expect(closed.sc.closed).toBe(true);
    const after = await call('hostproto_surface_observe', { surface });
    expect(after.sc.code).toBe('host_rejected');
  });
});
