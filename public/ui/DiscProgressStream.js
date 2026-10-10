// Disc progress is administrator-only, not merely application-access-only.
// EventSource cannot expose HTTP status codes, so close it on errors and check
// the public access-status endpoint before any controlled reconnection.
export class DiscProgressStream {
  constructor(onProgress, {
    eventTarget = window,
    fetchImpl = globalThis.fetch.bind(globalThis),
    EventSourceImpl = globalThis.EventSource,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis)
  } = {}) {
    this.onProgress = onProgress;
    this.eventTarget = eventTarget;
    this.fetchImpl = fetchImpl;
    this.EventSourceImpl = EventSourceImpl;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.source = null;
    this.retryTimer = null;
    this.request = null;
    this.generation = 0;
    this.retryDelay = 1000;
    this.started = false;
    this.suspended = false;
    this.onAuth = event => {
      if (event?.detail?.loggedIn) this.connect();
      else this.stop();
    };
    this.onStorage = event => {
      if (event.key === 'gharmonize_admin_token' || event.key === null) {
        if (event.newValue) this.connect();
        else this.stop();
      }
    };
    this.onPageHide = () => { this.suspended = true; this.stop(); };
    this.onPageShow = () => { this.suspended = false; this.connect(); };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.eventTarget.addEventListener('gharmonize:auth', this.onAuth);
    this.eventTarget.addEventListener('storage', this.onStorage);
    this.eventTarget.addEventListener('pagehide', this.onPageHide);
    this.eventTarget.addEventListener('pageshow', this.onPageShow);
    return this.connect();
  }

  stop() {
    this.generation += 1;
    this.request?.abort();
    this.request = null;
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.source?.close();
    this.source = null;
    this.retryDelay = 1000;
  }

  destroy() {
    this.stop();
    this.started = false;
    this.eventTarget.removeEventListener('gharmonize:auth', this.onAuth);
    this.eventTarget.removeEventListener('storage', this.onStorage);
    this.eventTarget.removeEventListener('pagehide', this.onPageHide);
    this.eventTarget.removeEventListener('pageshow', this.onPageShow);
  }

  scheduleReconnect() {
    if (!this.started || this.suspended || this.retryTimer !== null) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, 30_000);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  async connect() {
    if (!this.started || this.suspended || this.source || this.request) return;
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    if (!this.EventSourceImpl) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.request = controller;
    const timeout = this.setTimer(() => controller.abort(), 10_000);
    try {
      const response = await this.fetchImpl('/api/access/status', {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal
      });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) return;
      if (!response.ok) throw new Error(`Access status HTTP ${response.status}`);
      const access = await response.json();
      if (generation !== this.generation || controller.signal.aborted) return;
      if (!access.authorized || access.role !== 'admin') return;

      const source = new this.EventSourceImpl('/api/disc/stream');
      this.source = source;
      source.onopen = () => {
        if (this.source === source) this.retryDelay = 1000;
      };
      source.onmessage = event => {
        if (this.source !== source || !event.data) return;
        try {
          this.onProgress(JSON.parse(event.data));
        } catch (error) {
          console.error('disc progress parse error:', error);
        }
      };
      source.onerror = () => {
        if (this.source !== source) return;
        // Disable native retries: an expired or revoked session must not keep
        // requesting the protected stream or spam the console with 401s.
        source.close();
        this.source = null;
        this.scheduleReconnect();
      };
    } catch {
      if (generation === this.generation) this.scheduleReconnect();
    } finally {
      this.clearTimer(timeout);
      if (this.request === controller) this.request = null;
    }
  }
}
