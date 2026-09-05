const ADMIN_TOKEN_KEY = 'gharmonize_admin_token';
const REQUEST_STORAGE_KEY = 'gharmonize_access_request_id';

class AccessManager {
  constructor() {
    this.gate = null;
    this.status = null;
    this.accessResolver = null;
    this.requestPollTimer = null;
    this.statusTimer = null;
    this.requestCooldownTimer = null;
    this.started = false;
    this.authListenerBound = false;
  }

  t(key, fallback, vars) {
    const value = window.i18n?.t?.(key, vars);
    return !value || value === key ? fallback : value;
  }

  async ensureAccess() {
    this.createGate();
    let status;
    try {
      status = await this.fetchStatus();
    } catch (error) {
      this.showGate({ mode: 'admin', temporaryRequestsEnabled: false }, this.t('access.serverUnavailable', 'Gharmonize sunucusuna ulaşılamıyor.'));
      throw error;
    }

    this.applyStatus(status);
    if (status.authorized || status.mode === 'none') {
      this.hideGate();
      this.start();
      return status;
    }

    this.showGate(status);
    this.resumePendingRequest();
    await new Promise((resolve) => { this.accessResolver = resolve; });
    this.start();
    return this.status;
  }

  start() {
    if (!this.authListenerBound) {
      this.authListenerBound = true;
      window.addEventListener('gharmonize:auth', () => {
        window.setTimeout(() => this.refreshStatus().catch(() => {}), 0);
      });
      window.addEventListener('gharmonize:access-config-changed', () => {
        window.setTimeout(() => this.refreshStatus().catch(() => {}), 0);
      });
    }
    if (this.started) return;
    this.started = true;
    this.scheduleStatusRefresh();
  }

  createGate() {
    if (this.gate || document.getElementById('gharmonizeAccessGate')) {
      this.gate = document.getElementById('gharmonizeAccessGate');
      return;
    }

    const gate = document.createElement('div');
    gate.id = 'gharmonizeAccessGate';
    gate.className = 'access-gate';
    gate.hidden = true;
    gate.innerHTML = `
      <div class="access-gate__card" role="dialog" aria-modal="true" aria-labelledby="accessGateTitle">
        <img class="access-gate__logo" src="/src/logo.png" alt="Gharmonize" />
        <h1 id="accessGateTitle" class="access-gate__title">Gharmonize</h1>
        <p id="accessGateSubtitle" class="access-gate__subtitle"></p>
        <form id="accessGateLoginForm" class="access-gate__form" autocomplete="off">
          <label class="access-gate__label" for="accessGatePassword"></label>
          <input id="accessGatePassword" class="access-gate__input" type="password" autocomplete="current-password" />
          <div id="accessGateError" class="access-gate__error" role="alert" hidden></div>
          <div class="access-gate__actions">
            <button id="accessGateLoginBtn" class="access-gate__button access-gate__button--primary" type="submit"></button>
            <button id="accessGateRequestBtn" class="access-gate__button access-gate__button--secondary" type="button"></button>
          </div>
        </form>
        <div id="accessGateWaiting" class="access-gate__waiting" hidden>
          <div class="access-gate__spinner" aria-hidden="true"></div>
          <strong id="accessGateWaitingTitle"></strong>
          <span id="accessGateWaitingText"></span>
        </div>
      </div>
    `;
    document.body.appendChild(gate);
    this.gate = gate;

    gate.querySelector('#accessGateLoginForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.login().catch(() => {});
    });
    gate.querySelector('#accessGateRequestBtn')?.addEventListener('click', () => {
      this.requestTemporaryAccess().catch(() => {});
    });
    this.refreshGateText();
  }

  refreshGateText() {
    if (!this.gate) return;
    const set = (selector, value) => {
      const el = this.gate.querySelector(selector);
      if (el) el.textContent = value;
    };
    set('#accessGateSubtitle', this.t('access.subtitle', 'Bu Gharmonize sunucusuna erişmek için yetkilendirme gerekiyor.'));
    set('.access-gate__label', this.t('settings.adminPassword', 'Yönetici Şifresi'));
    set('#accessGateLoginBtn', this.t('btn.login', 'Giriş yap'));
    set('#accessGateRequestBtn', this.t('access.requestButton', 'Kullanım izni iste'));
    set('#accessGateWaitingTitle', this.t('access.waitingTitle', 'Yönetici onayı bekleniyor'));
    set('#accessGateWaitingText', this.t('access.waitingText', 'İsteğiniz yöneticiye iletildi. Bu ekranı açık bırakabilirsiniz.'));
  }

  async fetchStatus() {
    const response = await fetch('/api/access/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Access status HTTP ${response.status}`);
    return response.json();
  }

  applyStatus(status) {
    this.status = status || {};
    const isAdmin = this.status.role === 'admin';
    if (isAdmin) {
      localStorage.setItem(ADMIN_TOKEN_KEY, 'cookie');
    } else if (!this.status.authorized || this.status.role !== 'admin') {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
  }

  async refreshStatus() {
    const status = await this.fetchStatus();
    this.applyStatus(status);
    if (status.mode === 'none' || status.authorized) {
      this.hideGate();
      this.resolveAccessWaiter();
    } else {
      this.showGate(status);
    }
    this.scheduleStatusRefresh();
    return status;
  }

  scheduleStatusRefresh() {
    if (this.statusTimer) window.clearTimeout(this.statusTimer);
    let delay = 30000;
    if (this.status?.role === 'temporary' && Number(this.status?.expiresAt) > Date.now()) {
      delay = Math.max(1000, Math.min(3000, Number(this.status.expiresAt) - Date.now() + 250));
    }
    this.statusTimer = window.setTimeout(() => this.refreshStatus().catch(() => this.scheduleStatusRefresh()), delay);
  }

  showGate(status = this.status, errorMessage = '') {
    this.createGate();
    this.refreshGateText();
    this.status = status || this.status || {};
    const requestBtn = this.gate.querySelector('#accessGateRequestBtn');
    if (requestBtn) requestBtn.hidden = !this.status.temporaryRequestsEnabled;
    const error = this.gate.querySelector('#accessGateError');
    if (errorMessage && error) {
      error.textContent = errorMessage;
      error.hidden = false;
    }
    this.gate.hidden = false;
    document.body.classList.add('gharmonize-access-locked');
    requestAnimationFrame(() => this.gate.querySelector('#accessGatePassword')?.focus());
  }

  hideGate() {
    if (!this.gate) return;
    this.gate.hidden = true;
    document.body.classList.remove('gharmonize-access-locked');
    const waiting = this.gate.querySelector('#accessGateWaiting');
    const form = this.gate.querySelector('#accessGateLoginForm');
    if (waiting) waiting.hidden = true;
    if (form) form.hidden = false;
  }

  resolveAccessWaiter() {
    if (!this.accessResolver) return;
    const resolve = this.accessResolver;
    this.accessResolver = null;
    resolve();
  }

  setError(message = '') {
    const error = this.gate?.querySelector('#accessGateError');
    if (!error) return;
    error.textContent = String(message || '');
    error.hidden = !message;
  }

  setBusy(busy) {
    const loginBtn = this.gate?.querySelector('#accessGateLoginBtn');
    const requestBtn = this.gate?.querySelector('#accessGateRequestBtn');
    const password = this.gate?.querySelector('#accessGatePassword');
    if (loginBtn) loginBtn.disabled = !!busy;
    if (requestBtn) requestBtn.disabled = !!busy;
    if (password) password.disabled = !!busy;
  }

  async login() {
    const passwordEl = this.gate?.querySelector('#accessGatePassword');
    const password = String(passwordEl?.value || '');
    this.setError('');
    if (!password) {
      this.setError(this.t('errors.emptyPassword', 'Lütfen şifreyi girin.'));
      passwordEl?.focus();
      return;
    }

    this.setBusy(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || this.t('errors.loginFailed', 'Giriş başarısız.'));
      }
      localStorage.setItem(ADMIN_TOKEN_KEY, 'cookie');
      window.dispatchEvent(new CustomEvent('gharmonize:auth', { detail: { loggedIn: true } }));
      if (passwordEl) passwordEl.value = '';
      await this.refreshStatus();
      this.resolveAccessWaiter();
    } catch (error) {
      this.setError(error?.message || this.t('errors.loginFailed', 'Giriş başarısız.'));
      passwordEl?.focus();
    } finally {
      this.setBusy(false);
    }
  }

  formatRetryDelay(retryAt) {
    const remainingMs = Math.max(0, Number(retryAt || 0) - Date.now());
    const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
    return this.t('access.requestCooldown', `İstek reddedildi. ${minutes} dakika sonra tekrar deneyebilirsiniz.`, { minutes });
  }

  applyRequestCooldown(retryAt) {
    const requestBtn = this.gate?.querySelector('#accessGateRequestBtn');
    const until = Number(retryAt || 0);
    if (!requestBtn || !Number.isFinite(until) || until <= Date.now()) return;
    requestBtn.disabled = true;
    this.setError(this.formatRetryDelay(until));
    if (this.requestCooldownTimer) window.clearTimeout(this.requestCooldownTimer);
    this.requestCooldownTimer = window.setTimeout(() => {
      this.requestCooldownTimer = null;
      requestBtn.disabled = false;
      this.setError('');
    }, Math.max(250, until - Date.now() + 250));
  }

  async requestTemporaryAccess() {
    this.setError('');
    this.setBusy(true);
    try {
      const response = await fetch('/api/access/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429 && body?.error?.code === 'ACCESS_REQUEST_COOLDOWN' && Number(body?.retryAt) > Date.now()) {
          this.setBusy(false);
          this.applyRequestCooldown(body.retryAt);
          return;
        }
        if (response.status === 409 && body?.error?.code === 'ACCESS_REQUEST_IP_PENDING') {
          throw new Error(this.t('access.requestIpPending', 'Bu IP adresinden zaten bekleyen bir erişim isteği var.'));
        }
        if (response.status === 409 && body?.error?.code === 'ACCESS_IP_ALREADY_AUTHORIZED') {
          throw new Error(this.t('access.ipAlreadyAuthorized', 'Bu IP adresinin zaten aktif geçici kullanım izni var.'));
        }
        throw new Error(body?.error?.message || this.t('access.requestFailed', 'Kullanım izni isteği gönderilemedi.'));
      }
      sessionStorage.setItem(REQUEST_STORAGE_KEY, body.id);
      this.showWaiting();
      this.pollRequest(body.id);
    } catch (error) {
      this.setError(error?.message || this.t('access.requestFailed', 'Kullanım izni isteği gönderilemedi.'));
      this.setBusy(false);
    }
  }

  resumePendingRequest() {
    if (!this.status?.temporaryRequestsEnabled) return;
    const requestId = sessionStorage.getItem(REQUEST_STORAGE_KEY);
    if (!requestId) return;
    this.showWaiting();
    this.pollRequest(requestId);
  }

  showWaiting() {
    const form = this.gate?.querySelector('#accessGateLoginForm');
    const waiting = this.gate?.querySelector('#accessGateWaiting');
    if (form) form.hidden = true;
    if (waiting) waiting.hidden = false;
  }

  showLoginForm() {
    const form = this.gate?.querySelector('#accessGateLoginForm');
    const waiting = this.gate?.querySelector('#accessGateWaiting');
    if (form) form.hidden = false;
    if (waiting) waiting.hidden = true;
    this.setBusy(false);
  }

  pollRequest(requestId) {
    if (this.requestPollTimer) window.clearTimeout(this.requestPollTimer);
    const run = async () => {
      try {
        const response = await fetch(`/api/access/request/${encodeURIComponent(requestId)}`, { cache: 'no-store' });
        if (response.status === 404) {
          sessionStorage.removeItem(REQUEST_STORAGE_KEY);
          this.showLoginForm();
          this.setError(this.t('access.requestExpired', 'Kullanım izni isteğinin süresi doldu. Tekrar isteyebilirsiniz.'));
          return;
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
        if (body.status === 'approved' && body.authorized) {
          sessionStorage.removeItem(REQUEST_STORAGE_KEY);
          await this.refreshStatus();
          this.resolveAccessWaiter();
          return;
        }
        if (body.status === 'rejected') {
          sessionStorage.removeItem(REQUEST_STORAGE_KEY);
          this.showLoginForm();
          if (Number(body.retryAt) > Date.now()) {
            this.applyRequestCooldown(body.retryAt);
          } else {
            this.setError(this.t('access.requestRejected', 'Kullanım izni isteği yönetici tarafından reddedildi.'));
          }
          return;
        }
        if (body.status === 'expired') {
          sessionStorage.removeItem(REQUEST_STORAGE_KEY);
          this.showLoginForm();
          this.setError(this.t('access.requestExpired', 'Kullanım izni isteğinin süresi doldu. Tekrar isteyebilirsiniz.'));
          return;
        }
        this.requestPollTimer = window.setTimeout(run, 2000);
      } catch (error) {
        this.requestPollTimer = window.setTimeout(run, 3000);
      }
    };
    run();
  }


}

export const accessManager = new AccessManager();
