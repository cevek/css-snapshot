// Extraction over raw CDP, no browser-automation library: `CdpPage` turns a CDP
// session factory into the two things `reworkStyles` uses from a playwright Page
// (`evaluate`, `context().newCDPSession()`), and `CdpConnection` is a minimal client
// over the browser websocket to get such sessions from a debugging endpoint.
// Playwright's `connectOverCDP` is NOT used on purpose: attaching it sends emulation
// overrides (focus, media, default fonts) into every tab, which would clobber what
// the page's owner set — this client sends nothing but the extractor's own commands.

import type { ExtractionPage, ExtractionSession } from './extract.ts';

type Listener = (params: any) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  sessionId?: string;
}

export class CdpConnection {
  readonly #ws: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Map<string, Set<Listener>>>();
  #closed = false;
  #sendTimeoutMs: number | undefined;
  #aborted: string | undefined;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)));
    ws.addEventListener('close', () => this.#fail(new Error('CDP connection closed')));
  }

  /** A browser that accepts the TCP connection but never completes the websocket
   *  handshake would otherwise hang the caller: the handshake has its own timeout and
   *  `signal` aborts it. */
  static async connect(wsUrl: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const fail = (why: string): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        ws.close();
        reject(new Error(why));
      };
      const onAbort = (): void => fail('connect aborted');
      const timer = setTimeout(() => fail(`no CDP handshake from ${wsUrl} in ${timeoutMs / 1000}s`), timeoutMs);
      if (signal?.aborted) return fail('connect aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => fail(`cannot connect to ${wsUrl}`), { once: true });
    });
    return new CdpConnection(ws);
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.#closed) return Promise.reject(new Error('CDP connection closed'));
    const teardown =
      method === 'Target.detachFromTarget' || (method === 'CSS.setStyleSheetText' && (params as { text?: string }).text === '');
    if (this.#aborted !== undefined && !teardown) return Promise.reject(new Error(this.#aborted));
    const id = this.#nextId++;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    const call = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, sessionId }));
    const limit = this.#sendTimeoutMs;
    if (limit === undefined) return call;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} did not answer in ${limit / 1000}s`));
      }, limit);
    });
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  }

  on(sessionId: string, event: string, fn: Listener): void {
    let bySession = this.#listeners.get(sessionId);
    if (!bySession) this.#listeners.set(sessionId, (bySession = new Map()));
    let set = bySession.get(event);
    if (!set) bySession.set(event, (set = new Set()));
    set.add(fn);
  }

  off(sessionId: string, event: string, fn: Listener): void {
    this.#listeners.get(sessionId)?.get(event)?.delete(fn);
  }

  dropSession(sessionId: string): void {
    this.#listeners.delete(sessionId);
  }

  /** Abort a stuck extraction without losing the socket: every pending call rejects at
   *  once, and so does every later call EXCEPT teardown — emptying a stylesheet (the
   *  extractor's probe-sheet `dispose`, which must still reach the page: the sheet outlives
   *  its session) and detaching. Those go through, each bounded by `cleanupTimeoutMs` in
   *  case the browser is what hangs. */
  abortPending(reason: string, cleanupTimeoutMs = 3000): void {
    this.#aborted = reason;
    this.#sendTimeoutMs = cleanupTimeoutMs;
    const err = new Error(reason);
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  close(): void {
    this.#fail(new Error('CDP connection closed'));
    this.#ws.close();
  }

  #onMessage(raw: string): void {
    const msg = JSON.parse(raw);
    if (typeof msg.id === 'number') {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else p.resolve(msg.result);
      return;
    }
    // A crashed or closed tab answers nothing more: fail its calls instead of leaving them hanging.
    if (msg.method === 'Target.detachedFromTarget') {
      for (const [id, p] of this.#pending) {
        if (p.sessionId !== msg.params.sessionId) continue;
        this.#pending.delete(id);
        p.reject(new Error('target detached'));
      }
    }
    const set = this.#listeners.get(msg.sessionId ?? '')?.get(msg.method);
    if (set) for (const fn of [...set]) fn(msg.params);
  }

  #fail(err: Error): void {
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }
}

export class CdpSession implements ExtractionSession {
  private readonly conn: CdpConnection;
  readonly sessionId: string;

  constructor(conn: CdpConnection, sessionId: string) {
    this.conn = conn;
    this.sessionId = sessionId;
  }

  send(method: string, params: object = {}): Promise<any> {
    return this.conn.send(method, params, this.sessionId);
  }

  on(event: string, fn: Listener): this {
    this.conn.on(this.sessionId, event, fn);
    return this;
  }

  off(event: string, fn: Listener): this {
    this.conn.off(this.sessionId, event, fn);
    return this;
  }

  async detach(): Promise<void> {
    this.conn.dropSession(this.sessionId);
    await this.conn.send('Target.detachFromTarget', { sessionId: this.sessionId });
  }
}

/** A browser websocket URL from a debugging endpoint: a `ws(s)://` URL as is, an
 *  `http(s)://host:port` via its `/json/version`. */
export async function browserWsUrl(endpoint: string): Promise<string> {
  if (/^wss?:\/\//.test(endpoint)) return endpoint;
  const url = new URL('/json/version', endpoint);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!webSocketDebuggerUrl) throw new Error(`${url}: no webSocketDebuggerUrl`);
  return webSocketDebuggerUrl;
}

export async function attach(conn: CdpConnection, targetId: string): Promise<CdpSession> {
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
  return new CdpSession(conn, sessionId);
}

/** A fresh CDP session attached to one page target. Extraction opens several per run
 *  (the probe matcher needs its own `CSS.enable` replay — backlog t-4b154n), so the
 *  core takes a factory, not one session. playwright:
 *  `() => page.context().newCDPSession(page)`; puppeteer: `() => page.createCDPSession()`;
 *  a raw endpoint: `() => attach(conn, targetId)`. */
export type OpenSession = () => Promise<ExtractionSession>;

/** `ExtractionPage` over one page target. No frame mode: a frame handed to
 *  `newCDPSession` is rejected rather than silently given the main document. */
export class CdpPage implements ExtractionPage {
  private readonly openSession: OpenSession;
  private readonly session: ExtractionSession;

  /** `session` runs `evaluate`; `CdpPage.open` makes one from the factory. */
  constructor(openSession: OpenSession, session: ExtractionSession) {
    this.openSession = openSession;
    this.session = session;
  }

  static async open(openSession: OpenSession): Promise<CdpPage> {
    return new CdpPage(openSession, await openSession());
  }

  /** Playwright semantics: a function runs with `arg` (JSON-serialisable), a string is
   *  evaluated as an expression; the value comes back by value, promises awaited. */
  evaluate<R>(fn: string | (() => R | Promise<R>)): Promise<R>;
  evaluate<R, Arg>(fn: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
  async evaluate(fn: string | ((arg: any) => unknown), arg?: unknown): Promise<any> {
    const expression =
      typeof fn === 'string' ? fn : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    const res = await this.session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`evaluate failed: ${d.exception?.description ?? d.text}`);
    }
    return res.result.value;
  }

  context(): { newCDPSession: (target: unknown) => Promise<ExtractionSession> } {
    return {
      newCDPSession: (target) => {
        if (target !== this) return Promise.reject(new Error('CdpPage: sessions for its own page only (no frame mode)'));
        return this.openSession();
      },
    };
  }

  detach(): Promise<void> {
    return this.session.detach();
  }
}
