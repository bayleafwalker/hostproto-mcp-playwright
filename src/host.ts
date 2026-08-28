// The Playwright host: the only place that touches a browser. Everything it
// returns is a HostProto object validated against the pinned bundle before
// it leaves. Revision, cursor, target invalidation, preconditions, receipts
// and deviations are computed here, never by the MCP layer.
import { chromium, type Browser, type BrowserContext, type Page, type Dialog } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { assertValid } from './schemas.js';

export class HostProtoError extends Error {
  constructor(public code: string, message: string, public hostInvoked: boolean, public data: Record<string, unknown> = {}) { super(message); }
  toObject() {
    const error = { schema_version: 'hostproto.error/v1', code: this.code, message: this.message.slice(0, 1024), host_invoked: this.hostInvoked, data: this.data };
    assertValid('error', error);
    return error;
  }
}

const sha = (data: string | Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const opaque = (prefix: string) => `${prefix}-${randomUUID().slice(0, 12)}`;

// Same enumeration as browser-workbench's native lane and its oracle, so
// `data.targets[N]` names the same element across every conformance backend.
const TARGET_SCRIPT = `(() => {
  const selector = 'a[href], button, input, select, textarea, [contenteditable="true"]';
  return Array.from(document.querySelectorAll(selector)).map((element, index) => {
    const id = 'target-' + (index + 1);
    element.setAttribute('data-wb-target', id);
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    const role = element.getAttribute('role')
      || (tag === 'a' ? 'link' : tag === 'button' ? 'button'
      : (tag === 'input' && type === 'file') ? 'file'
      : (tag === 'input' || tag === 'textarea') ? 'textbox' : tag);
    const name = (element.getAttribute('aria-label') || element.textContent || element.value || element.id || '').trim().slice(0, 80);
    return { target_id: id, role, name, actions: role === 'textbox' ? ['type', 'click'] : ['click'] };
  });
})()`;

export const INTENT_FAMILY = ['navigate', 'javascript', 'click', 'type', 'dialog.resolve'] as const;
export const PROJECTIONS = ['state', 'dom', 'console', 'network', 'targets', 'dialogs', 'screenshot'] as const;
export const ASSERTABLE = ['url', 'title', 'revision'] as const;

interface Event { event_id: string; seq: number; kind: string; revision: number; payload: Record<string, unknown> }
interface PendingDialog { token: string; kind: 'dialog'; dialog_type: string; message: string; status: 'pending' | 'resolved'; default: 'deny'; decision?: string; handle: Dialog }

export interface Surface {
  id: string; contextId: string; page: Page; revision: number; lifecycle: 'open' | 'closed' | 'terminated';
  events: Event[]; seq: number; dialogs: Map<string, PendingDialog>; screenshots: Map<string, Buffer>;
}
interface Ctx { id: string; hostId: string; context: BrowserContext; surfaces: Set<string>; writer: { fence_id: string; epoch: number; holder?: string } }

export interface Artifact { uri: string; mediaType: string; bytes: Buffer }
export type SurfaceListener = (surfaceId: string) => void;

export class PlaywrightHost {
  readonly hostId = opaque('host');
  private browser?: Browser;
  private contexts = new Map<string, Ctx>();
  private surfaces = new Map<string, Surface>();
  readonly ledger = new Map<string, number>();
  private listeners = new Set<SurfaceListener>();
  private counters = { action: 0, receipt: 0, screenshot: 0 };

  onSurfaceChanged(listener: SurfaceListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async engine() { this.browser ??= await chromium.launch({ headless: true }); return this.browser; }
  version() { return this.browser?.version() ?? 'not launched'; }

  private exercised(name: string) { this.ledger.set(name, (this.ledger.get(name) ?? 0) + 1); }

  private surface(id: string): Surface {
    const surface = this.surfaces.get(id);
    if (!surface) throw new HostProtoError('handle_expired', `unknown or expired surface ${id}`, false, { surface: id });
    if (surface.lifecycle !== 'open') throw new HostProtoError('host_rejected', `surface is ${surface.lifecycle}`, false, { surface: id, lifecycle: surface.lifecycle });
    return surface;
  }

  private emit(surface: Surface, kind: string, payload: Record<string, unknown> = {}) {
    surface.seq += 1;
    surface.events.push({ event_id: `${surface.id}-evt-${String(surface.seq).padStart(6, '0')}`, seq: surface.seq, kind, revision: surface.revision, payload });
    for (const listener of this.listeners) listener(surface.id);
  }

  // -- handles --------------------------------------------------------------
  async createContext(params: { profile?: { mode?: string }; client?: { id?: string }; viewport?: { width: number; height: number } }) {
    const mode = params.profile?.mode ?? 'ephemeral';
    if (mode !== 'ephemeral') throw new HostProtoError('capability_unsupported', 'only ephemeral profiles are supported by this adapter', false, { mode });
    const browser = await this.engine();
    const context = await browser.newContext({ viewport: params.viewport ?? { width: 1024, height: 768 } });
    const ctx: Ctx = { id: opaque('ctx'), hostId: this.hostId, context, surfaces: new Set(), writer: { fence_id: opaque('fence'), epoch: 1, holder: params.client?.id } };
    this.contexts.set(ctx.id, ctx);
    const page = await context.newPage();
    const surface = this.attach(ctx, page);
    this.exercised('context.create'); this.exercised('profile.ephemeral');
    return this.handles(ctx, surface);
  }

  private attach(ctx: Ctx, page: Page): Surface {
    const surface: Surface = { id: opaque('surface'), contextId: ctx.id, page, revision: 1, lifecycle: 'open', events: [], seq: 0, dialogs: new Map(), screenshots: new Map() };
    this.surfaces.set(surface.id, surface); ctx.surfaces.add(surface.id);
    page.on('framenavigated', frame => { if (frame !== page.mainFrame()) return; surface.revision += 1; this.emit(surface, 'navigation.committed', { url: frame.url() }); });
    page.on('load', () => this.emit(surface, 'navigation.finished', { url: page.url() }));
    page.on('console', m => this.emit(surface, 'console.message', { level: m.type(), text: m.text() }));
    page.on('request', r => this.emit(surface, 'network.request', { url: r.url(), method: r.method() }));
    page.on('response', r => this.emit(surface, 'network.response', { url: r.url(), status: r.status() }));
    page.on('dialog', dialog => {
      const token = opaque('dialog');
      surface.dialogs.set(token, { token, kind: 'dialog', dialog_type: dialog.type(), message: dialog.message(), status: 'pending', default: 'deny', handle: dialog });
      this.emit(surface, 'dialog.opened', { token, dialog_type: dialog.type() });
    });
    page.on('crash', () => { surface.lifecycle = 'terminated'; this.emit(surface, 'surface.terminated', { reason: 'crash' }); });
    page.on('close', () => { if (surface.lifecycle === 'open') surface.lifecycle = 'closed'; });
    return surface;
  }

  handles(ctx: Ctx, surface: Surface) {
    const handles = {
      schema_version: 'hostproto.handles/v1',
      host: { id: this.hostId, kind: 'host', expires: null },
      context: { id: ctx.id, kind: 'context', expires: null },
      surface: { id: surface.id, kind: 'surface', expires: null, lifecycle: surface.lifecycle },
      adapter_profile: 'browser/v1',
      writer: { fence_id: ctx.writer.fence_id, epoch: ctx.writer.epoch, ...(ctx.writer.holder ? { holder: ctx.writer.holder } : {}) },
    };
    assertValid('handles', handles);
    return handles;
  }

  async closeContext(id: string) {
    const ctx = this.contexts.get(id);
    if (!ctx) throw new HostProtoError('handle_expired', `unknown or expired context ${id}`, false, { context: id });
    for (const sid of ctx.surfaces) { const s = this.surfaces.get(sid); if (s) { s.lifecycle = 'closed'; } }
    await ctx.context.close();
    this.contexts.delete(id);
    this.exercised('context.close');
    return { context: id, closed: true, surfaces: [...ctx.surfaces] };
  }

  // -- observation ----------------------------------------------------------
  private async state(surface: Surface) {
    return { url: surface.page.url(), title: await surface.page.title(), lifecycle: surface.lifecycle, revision: surface.revision };
  }

  async observe(params: { surface: string; projections?: string[]; since?: number; max_bytes?: number }) {
    const surface = this.surface(params.surface);
    const projections = params.projections?.length ? params.projections : ['state'];
    const since = params.since ?? 0;
    const maxBytes = params.max_bytes ?? 262144;
    if (maxBytes < 512) throw new HostProtoError('invalid_request', 'max_bytes must be at least 512', false);
    const unknown = projections.filter(p => !(PROJECTIONS as readonly string[]).includes(p));
    if (unknown.length) throw new HostProtoError('capability_unsupported', 'unsupported projection', false, { projections: unknown });
    const data: Record<string, unknown> = {};
    const artifacts: Artifact[] = [];
    const evidence: unknown[] = [];
    const eventsSince = (pred: (e: Event) => boolean) => surface.events.filter(e => e.seq > since && pred(e));
    for (const projection of projections) {
      if (projection === 'state') data.state = await this.state(surface);
      else if (projection === 'dom') { const html = await surface.page.content(); data.dom = { html, sha256: sha(html) }; }
      else if (projection === 'console') data.console = eventsSince(e => e.kind === 'console.message');
      else if (projection === 'network') data.network = eventsSince(e => e.kind.startsWith('network.'));
      else if (projection === 'targets') {
        const found = await surface.page.evaluate(TARGET_SCRIPT) as Array<Record<string, unknown>>;
        data.targets = found.map(t => ({ schema_version: 'hostproto.target-ref/v1', surface: surface.id, revision: surface.revision, ...t }));
        for (const target of data.targets as unknown[]) assertValid('target-ref', target);
      }
      else if (projection === 'dialogs') data.dialogs = [...surface.dialogs.values()].map(({ handle, ...rest }) => rest);
      else if (projection === 'screenshot') {
        const png = await surface.page.screenshot({ type: 'png' });
        this.counters.screenshot += 1;
        const name = `screenshot-${String(this.counters.screenshot).padStart(4, '0')}`;
        surface.screenshots.set(name, png);
        const uri = `hostproto://surface/${surface.id}/screenshot/${name}`;
        artifacts.push({ uri, mediaType: 'image/png', bytes: png });
        const ref = { schema_version: 'hostproto.evidence-ref/v1', ref: sha(png), surface_class: 'raw', media_type: 'image/png', size_bytes: png.length, path: uri };
        assertValid('evidence-ref', ref);
        evidence.push(ref);
        data.screenshot = { ...ref, resource: uri };
      }
    }
    const observation: Record<string, unknown> = {
      schema_version: 'hostproto.observation/v1', surface: surface.id, revision: surface.revision,
      cursor: { since, next: surface.seq }, projections, data,
      bounded: { max_bytes: maxBytes, lossy: false, omitted: {}, raw_ref: null }, provider: 'engine', deviations: [],
    };
    // Loss is explicit: lists are truncated to their first element and the
    // omission counted; a full copy is retained as a raw artifact.
    if (Buffer.byteLength(JSON.stringify(observation)) > maxBytes) {
      const full = JSON.stringify(observation);
      const rawUri = `hostproto://surface/${surface.id}/observation/${sha(full).slice(7, 19)}`;
      artifacts.push({ uri: rawUri, mediaType: 'application/json', bytes: Buffer.from(full) });
      const omitted: Record<string, number> = {}; const compact: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (k === 'state') compact[k] = v;
        else if (Array.isArray(v)) { compact[k] = v.slice(0, 1); omitted[k] = Math.max(0, v.length - 1); }
        else { compact[k] = { omitted: true }; omitted[k] = 1; }
      }
      observation.data = compact;
      observation.bounded = { max_bytes: maxBytes, lossy: true, omitted, raw_ref: sha(full) };
    }
    assertValid('observation', observation);
    for (const p of projections) this.exercised(`observe.${p}`);
    return { observation, artifacts, evidence };
  }

  // -- action ---------------------------------------------------------------
  private checkTarget(surface: Surface, target: Record<string, unknown> | undefined, action: string) {
    if (!target) throw new HostProtoError('invalid_request', `${action} requires a target`, false);
    if (target.surface !== surface.id) throw new HostProtoError('target_invalidated', 'target belongs to another surface', false, { target_id: target.target_id });
    if (target.revision !== surface.revision) {
      // Rejected before the host is invoked: a stale reference never reaches the engine.
      throw new HostProtoError('target_invalidated', 'target belongs to an earlier revision', false,
        { target_id: target.target_id, target_revision: target.revision, surface_revision: surface.revision });
    }
    const actions = (target.actions as string[] | undefined) ?? [];
    if (!actions.includes(action)) throw new HostProtoError('capability_unsupported', 'target does not declare this action', false, { target_id: target.target_id, action });
    return `[data-wb-target="${target.target_id}"]`;
  }

  private async checkPreconditions(surface: Surface, pre: Record<string, unknown> | undefined) {
    if (!pre) return;
    assertValid('precondition', pre);
    if (pre.surface !== surface.id) throw new HostProtoError('precondition_failed', 'precondition names another surface', false);
    if (pre.revision !== undefined && pre.revision !== surface.revision) throw new HostProtoError('precondition_failed', 'surface revision does not match', false, { expected: pre.revision, observed: surface.revision });
    const state = await this.state(surface);
    for (const { field, equals } of pre.assertions as Array<{ field: string; equals: unknown }>) {
      if (!(ASSERTABLE as readonly string[]).includes(field)) throw new HostProtoError('invalid_request', `field is not assertable in browser/v1: ${field}`, false);
      const observed = (state as Record<string, unknown>)[field];
      if (observed !== equals) throw new HostProtoError('precondition_failed', `surface ${field} does not match`, false, { field, expected: equals, observed });
    }
  }

  async act(intent: Record<string, unknown>) {
    assertValid('intent', intent);
    const surface = this.surface(intent.surface as string);
    const kind = intent.kind as string;
    if (!(INTENT_FAMILY as readonly string[]).includes(kind)) throw new HostProtoError('capability_unsupported', 'intent kind is outside browser/v1', false, { kind, family: INTENT_FAMILY });
    await this.checkPreconditions(surface, intent.preconditions as Record<string, unknown> | undefined);
    const params = (intent.params ?? {}) as Record<string, unknown>;
    const target = intent.target as Record<string, unknown> | undefined;
    // Everything above ran before the host was touched.
    const revisionBefore = surface.revision;
    const stateBefore = sha(JSON.stringify(await this.state(surface)));
    const cursor = surface.seq;
    let effects: Array<Record<string, unknown>> = [];
    let hostInvoked = false;
    const deviations: Array<Record<string, unknown>> = [];
    let outcome: 'completed' | 'unknown' = 'completed';
    try {
      hostInvoked = true;
      if (kind === 'navigate') {
        const url = String(params.url ?? '');
        if (!/^https?:\/\//.test(url)) throw new HostProtoError('invalid_request', 'only absolute http(s) URLs', false, { url });
        const response = await surface.page.goto(url, { waitUntil: 'commit', timeout: Number(params.deadline_ms ?? 30000) });
        effects = [{ kind: 'navigation', url: response?.url() ?? surface.page.url() }];
      } else if (kind === 'javascript') {
        const value = await surface.page.evaluate(String(params.value ?? ''));
        effects = [{ kind: 'javascript', value: value === undefined ? null : value }];
      } else if (kind === 'click') {
        hostInvoked = false; const selector = this.checkTarget(surface, target, 'click'); hostInvoked = true;
        await surface.page.click(selector, { timeout: 15000 });
        effects = [{ kind: 'click', target_id: target!.target_id }];
      } else if (kind === 'type') {
        hostInvoked = false; const selector = this.checkTarget(surface, target, 'type'); hostInvoked = true;
        await surface.page.fill(selector, String(params.value ?? ''), { timeout: 15000 });
        effects = [{ kind: 'type', target_id: target!.target_id, value: await surface.page.inputValue(selector) }];
      } else if (kind === 'dialog.resolve') {
        hostInvoked = false;
        const record = surface.dialogs.get(String(intent.decision_token));
        if (!record || record.status !== 'pending') throw new HostProtoError('precondition_failed', 'decision token is unknown or already resolved', false, { decision_token: intent.decision_token });
        const decision = String(params.decision ?? record.default === 'deny' ? 'dismiss' : 'accept');
        if (!['accept', 'dismiss'].includes(decision)) throw new HostProtoError('invalid_request', 'unknown decision', false, { decision });
        hostInvoked = true;
        if (decision === 'accept') await record.handle.accept(String(params.value ?? '')); else await record.handle.dismiss();
        record.status = 'resolved'; record.decision = decision;
        this.emit(surface, 'dialog.resolved', { token: record.token, decision });
        effects = [{ kind: 'dialog.decision', decision, token: record.token }];
      }
    } catch (error) {
      if (error instanceof HostProtoError) throw error;
      const message = String((error as Error).message ?? error);
      if (/Timeout \d+ms exceeded/.test(message)) {
        // The host was invoked and the deadline elapsed: the effect may have escaped.
        outcome = 'unknown';
        deviations.push({ kind: 'divergence', reason: 'deadline elapsed after the host was invoked; state reconciled from the next observation' });
      } else throw new HostProtoError('host_failed', message, hostInvoked);
    }
    const caused = surface.events.filter(e => e.seq > cursor).map(e => e.event_id);
    this.counters.action += 1; this.counters.receipt += 1;
    const receipt = {
      schema_version: 'hostproto.receipt/v1',
      receipt_id: `receipt-${String(this.counters.receipt).padStart(4, '0')}`,
      action_id: intent.action_id, surface: surface.id,
      attempted: true, accepted: true, executed: outcome === 'completed', verified: outcome === 'completed' && (caused.length > 0 || effects.length > 0),
      outcome, provider: kind === 'javascript' || kind === 'navigate' || kind === 'dialog.resolve' ? 'engine' : 'injected',
      caused_events: caused, effects, revision_before: revisionBefore, revision_after: surface.revision,
      state_before: stateBefore, state_after: sha(JSON.stringify(await this.state(surface))), evidence: [], deviations,
    };
    assertValid('receipt', receipt);
    if (outcome === 'completed') this.exercised(`act.${kind}`);
    return receipt;
  }

  // -- wait -----------------------------------------------------------------
  async await(params: { surface: string; conditions: Array<{ kind: string; equals: unknown }>; deadline_ms?: number }) {
    const surface = this.surface(params.surface);
    const conditions = params.conditions ?? [];
    if (!conditions.length) throw new HostProtoError('invalid_request', 'await requires at least one condition', false);
    const deadline = Number(params.deadline_ms ?? 30000);
    const holds = async (c: { kind: string; equals: unknown }) => {
      if (c.kind === 'load_state') return c.equals === 'idle' ? await surface.page.evaluate('document.readyState') === 'complete' : false;
      if (c.kind === 'url') return surface.page.url() === c.equals;
      if (c.kind === 'title') return await surface.page.title() === c.equals;
      if (c.kind === 'revision') return surface.revision === c.equals;
      if (c.kind === 'event_kind') return surface.events.some(e => e.kind === c.equals);
      throw new HostProtoError('invalid_request', `unknown await condition: ${c.kind}`, false);
    };
    const until = Date.now() + deadline;
    for (;;) {
      const results = await Promise.all(conditions.map(holds));
      if (results.every(Boolean)) break;
      if (Date.now() >= until) {
        throw new HostProtoError('deadline_exceeded', 'await deadline elapsed', true, { unsatisfied: conditions.filter((_, i) => !results[i]), cursor: surface.seq });
      }
      await new Promise(r => setTimeout(r, 25));
    }
    this.exercised('await');
    return { satisfied: true, surface: surface.id, revision: surface.revision, cursor: { since: 0, next: surface.seq } };
  }

  // -- resources ------------------------------------------------------------
  async readSurfaceState(id: string) { const s = this.surfaces.get(id); if (!s) return undefined; return { ...(await this.state(s)), cursor: s.seq }; }
  screenshot(id: string, name: string) { return this.surfaces.get(id)?.screenshots.get(name); }
  listSurfaces() { return [...this.surfaces.values()].filter(s => s.lifecycle === 'open').map(s => s.id); }

  capabilityProfile() {
    const cap = (name: string, availability: string, provider: string, semantics: string) => {
      const runs = this.ledger.get(name) ?? 0;
      return [name, { availability, provider, semantics, verification: runs > 0 ? 'runtime' : 'source-audit', ...(runs > 0 ? { runtime_executions: runs } : {}) }] as const;
    };
    const profile = {
      schema_version: 'hostproto.capability-profile/v1', profile: 'browser/v1',
      adapter: { kind: 'playwright', variant: 'chromium', identity: { engine: this.version(), playwright: '1.62.1' } },
      immutable_per_run: true,
      capabilities: Object.fromEntries([
        cap('context.create', 'supported', 'host', 'normalized'), cap('profile.ephemeral', 'supported', 'engine', 'exact'),
        cap('context.close', 'supported', 'host', 'normalized'), cap('await', 'supported', 'host', 'normalized'),
        cap('observe.state', 'supported', 'engine', 'normalized'), cap('observe.dom', 'supported', 'engine', 'normalized'),
        cap('observe.console', 'supported', 'engine', 'exact'), cap('observe.network', 'supported', 'engine', 'exact'),
        cap('observe.targets', 'supported', 'injected', 'normalized'), cap('observe.dialogs', 'supported', 'engine', 'exact'),
        cap('observe.screenshot', 'supported', 'engine', 'exact'), cap('act.navigate', 'supported', 'engine', 'exact'),
        cap('act.javascript', 'supported', 'engine', 'exact'), cap('act.click', 'supported', 'engine', 'exact'),
        cap('act.type', 'supported', 'engine', 'exact'), cap('act.dialog.resolve', 'supported', 'engine', 'exact'),
      ]),
      intent_family: [...INTENT_FAMILY], projections: [...PROJECTIONS], assertable_fields: [...ASSERTABLE],
    };
    assertValid('capability-profile', profile);
    return profile;
  }

  async close() { for (const id of [...this.contexts.keys()]) await this.closeContext(id).catch(() => {}); await this.browser?.close(); this.browser = undefined; }
}
