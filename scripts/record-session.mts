// Record one real browser session as an NDJSON envelope log for an EvidenceSet consumer.
// Usage: npx tsx scripts/record-session.mts <out.ndjson>
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const out = process.argv[2]; if (!out) throw new Error('usage: record-session <out.ndjson>');
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixture = createServer(async (req, res) => {
  const file = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'index.html';
  try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(await readFile(FIXTURES + file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(fixture.address() as any).port}/`;
const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/stdio.ts'], cwd: fileURLToPath(new URL('..', import.meta.url)), stderr: 'pipe' });
const client = new Client({ name: 'vuoro-evidence-recorder', version: '0.0.1' });
client.setVersionNegotiation({ mode: { pin: '2026-07-28' } });
await client.connect(transport);

const lines: string[] = []; let seq = 0;
const call = async (tool: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name: tool, arguments: args });
  const sc = r.structuredContent as any;
  lines.push(JSON.stringify({ seq: seq++, at: new Date().toISOString(), tool, args, is_error: !!r.isError, structured: sc }));
  return sc;
};
const intent = (surface: string, action_id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ schema_version: 'hostproto.intent/v1', action_id, surface, kind, ...extra });

const h = await call('hostproto_context_create', { client: { id: 'vuoro-evidence-recorder' }, viewport: { width: 1024, height: 768 } });
const surface = h.surface.id;
await call('hostproto_surface_act', intent(surface, 'a-navigate', 'navigate', { params: { url: `${base}index.html` } }));
await call('hostproto_surface_await', { surface, conditions: [{ kind: 'load_state', equals: 'idle' }, { kind: 'title', equals: 'HostProto Fixture Index' }], deadline_ms: 10000 });
const obs = await call('hostproto_surface_observe', { surface, projections: ['state', 'targets'] });
const target = obs.data.targets[0];
await call('hostproto_surface_act', intent(surface, 'a-precondition', 'javascript', { params: { value: 'document.title' },
  preconditions: { schema_version: 'hostproto.precondition/v1', surface, assertions: [{ field: 'title', equals: 'Wrong' }] } }));
await call('hostproto_surface_act', intent(surface, 'a-click', 'click', { target, declared_effects: ['navigation'] }));
await call('hostproto_surface_await', { surface, conditions: [{ kind: 'url', equals: `${base}next.html` }, { kind: 'load_state', equals: 'idle' }], deadline_ms: 10000 });
await call('hostproto_surface_act', intent(surface, 'a-click-stale', 'click', { target }));
await call('hostproto_surface_observe', { surface, projections: ['state'] });
await call('hostproto_context_close', { context: h.context.id });
await client.close(); fixture.close();
await writeFile(out, lines.join('\n') + '\n');
console.log(`${lines.length} calls -> ${out}`);
