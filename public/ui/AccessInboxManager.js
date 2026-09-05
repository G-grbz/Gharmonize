class AccessInboxManager {
  constructor() {
    this.started = false;
    this.interval = null;
    this.inFlight = false;
    this.requests = [];
    this.active = [];
    this.duration = {};
  }

  t(key, fallback, vars) {
    const value = window.i18n?.t?.(key, vars);
    return !value || value === key ? fallback : value;
  }

  initialize() {
    if (this.started) return;
    this.started = true;
    this.bindEvents();
    window.addEventListener('gharmonize:auth', () => {
      this.syncAdminState().catch(() => this.goOffline());
    });
    document.addEventListener('i18n:applied', () => this.render());
    this.syncAdminState().catch(() => this.goOffline());
  }

  bindEvents() {
    document.getElementById('ytliveAccessBell')?.addEventListener('click', () => this.open());
    document.getElementById('ytliveAccessClose')?.addEventListener('click', () => this.close());
    document.getElementById('ytliveAccessOverlay')?.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.getElementById('ytliveAccessPanel')?.getAttribute('aria-hidden') === 'false') {
        this.close();
      }
    });
  }

  async syncAdminState() {
    const response = await fetch('/api/access/status', { cache: 'no-store' });
    if (!response.ok) {
      this.goOffline();
      return false;
    }
    const status = await response.json().catch(() => ({}));
    const isAdmin = status?.authorized === true && status?.role === 'admin';
    if (isAdmin) this.goOnline();
    else this.goOffline();
    return isAdmin;
  }

  goOnline() {
    const bell = document.getElementById('ytliveAccessBell');
    if (bell) bell.hidden = false;
    this.refresh().catch(() => {});
    if (!this.interval) {
      this.interval = window.setInterval(() => this.refresh().catch(() => {}), 2500);
    }
  }

  goOffline() {
    if (this.interval) {
      window.clearInterval(this.interval);
      this.interval = null;
    }
    this.requests = [];
    this.active = [];
    const bell = document.getElementById('ytliveAccessBell');
    if (bell) bell.hidden = true;
    this.close();
    this.updateIndicator();
    this.render();
  }

  async refresh() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const response = await fetch('/api/access/requests', { cache: 'no-store' });
      if (response.status === 401 || response.status === 403) {
        this.goOffline();
        return;
      }
      if (!response.ok) throw new Error(`Access inbox HTTP ${response.status}`);
      const body = await response.json();
      this.requests = Array.isArray(body?.requests) ? body.requests : [];
      this.active = Array.isArray(body?.active) ? body.active : [];
      this.duration = body?.temporaryDuration || {};
      this.updateIndicator();
      this.render();
    } finally {
      this.inFlight = false;
    }
  }

  updateIndicator() {
    const bell = document.getElementById('ytliveAccessBell');
    const badge = document.getElementById('ytliveAccessBadge');
    if (!bell || !badge) return;
    const count = this.requests.length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
    bell.classList.toggle('has-pending', count > 0);
    bell.title = count > 0
      ? this.t('access.pendingCount', `${count} bekleyen erişim isteği`, { count })
      : this.t('access.requestsTab', 'Erişim İstekleri');
    bell.setAttribute('aria-label', bell.title);
  }

  open() {
    const panel = document.getElementById('ytliveAccessPanel');
    const overlay = document.getElementById('ytliveAccessOverlay');
    if (!panel) return;
    panel.setAttribute('aria-hidden', 'false');
    panel.removeAttribute('inert');
    if (overlay) overlay.hidden = false;
    this.refresh().catch(() => {});
    window.requestAnimationFrame(() => document.getElementById('ytliveAccessClose')?.focus());
  }

  close() {
    const panel = document.getElementById('ytliveAccessPanel');
    const overlay = document.getElementById('ytliveAccessOverlay');
    if (!panel) return;
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('inert', '');
    if (overlay) overlay.hidden = true;
  }

  escape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  formatDuration(duration = {}) {
    const parts = [];
    const values = [
      [duration.years, this.t('access.unitYear', 'yıl')],
      [duration.months, this.t('access.unitMonth', 'ay')],
      [duration.days, this.t('access.unitDay', 'gün')],
      [duration.hours, this.t('access.unitHour', 'saat')]
    ];
    values.forEach(([value, unit]) => {
      if (Number(value) > 0) parts.push(`${Number(value)} ${unit}`);
    });
    return parts.join(' ') || `1 ${this.t('access.unitHour', 'saat')}`;
  }

  async decide(id, decision, buttons = []) {
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch(`/api/access/requests/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
      window.app?.showNotification?.(
        decision === 'approve'
          ? this.t('access.approvedToast', 'Geçici kullanım izni onaylandı.')
          : this.t('access.rejectedToast', 'Kullanım izni isteği reddedildi.'),
        decision === 'approve' ? 'success' : 'info'
      );
      await this.refresh();
    } catch (error) {
      window.app?.showNotification?.(error?.message || this.t('access.requestFailed', 'İşlem başarısız.'), 'error');
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async revoke(id, buttons = []) {
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch(`/api/access/grants/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
      window.app?.showNotification?.(this.t('access.revokedToast', 'Geçici kullanım izni sonlandırıldı.'), 'info');
      await this.refresh();
    } catch (error) {
      window.app?.showNotification?.(error?.message || this.t('access.revokeFailed', 'Geçici kullanım izni sonlandırılamadı.'), 'error');
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  render() {
    const root = document.getElementById('ytliveAccessList');
    const title = document.getElementById('ytliveAccessTitle');
    if (!root) return;
    if (title) title.textContent = this.t('access.requestsTab', 'Erişim İstekleri');

    if (!this.requests.length && !this.active.length) {
      root.innerHTML = `
        <div class="ytlive-access-empty">
          <strong>${this.escape(this.t('access.requestsEmpty', 'Bekleyen erişim isteği yok'))}</strong>
          <span>${this.escape(this.t('access.requestsEmptyHint', 'Yeni istekler burada görünür.'))}</span>
        </div>`;
      return;
    }

    const pending = this.requests.length ? `
      <section class="ytlive-access-section">
        <div class="ytlive-access-section__heading">
          <span>${this.escape(this.t('access.pendingRequestsTitle', 'Bekleyen istekler'))}</span>
          <span>${this.requests.length}</span>
        </div>
        ${this.requests.map((request) => {
          const id = this.escape(request.id || '');
          return `
            <article class="ytlive-access-card" data-ytlive-access-request="${id}">
              <div class="ytlive-access-card__head">
                <strong>${this.escape(request.ip || '-')}</strong>
                <span>${this.escape(this.t('access.pending', 'Bekliyor'))}</span>
              </div>
              <div class="ytlive-access-card__meta">${this.escape(new Date(Number(request.createdAt || 0)).toLocaleString())}</div>
              <div class="ytlive-access-card__meta">${this.escape(this.formatDuration(this.duration))}</div>
              <div class="ytlive-access-card__client">${this.escape(request.userAgent || '-')}</div>
              <div class="ytlive-access-card__actions">
                <button class="secondary-button" type="button" data-ytlive-access-decision="reject" data-id="${id}">${this.escape(this.t('access.reject', 'Reddet'))}</button>
                <button class="primary-button" type="button" data-ytlive-access-decision="approve" data-id="${id}">${this.escape(this.t('access.approve', 'Onayla'))}</button>
              </div>
            </article>`;
        }).join('')}
      </section>` : '';

    const active = this.active.length ? `
      <section class="ytlive-access-section">
        <div class="ytlive-access-section__heading">
          <span>${this.escape(this.t('access.activeGrantsTitle', 'Aktif geçici erişimler'))}</span>
          <span>${this.active.length}</span>
        </div>
        ${this.active.map((grant) => {
          const id = this.escape(grant.id || '');
          return `
            <article class="ytlive-access-card ytlive-access-card--active" data-ytlive-access-grant="${id}">
              <div class="ytlive-access-card__head">
                <strong>${this.escape(grant.ip || '-')}</strong>
                <span>${this.escape(this.t('access.active', 'Aktif'))}</span>
              </div>
              <div class="ytlive-access-card__meta">${this.escape(this.t('access.expiresLabel', 'Bitiş'))}: ${this.escape(new Date(Number(grant.expiresAt || 0)).toLocaleString())}</div>
              <div class="ytlive-access-card__client">${this.escape(grant.userAgent || '-')}</div>
              <div class="ytlive-access-card__actions">
                <button class="secondary-button" type="button" data-ytlive-access-revoke="${id}">${this.escape(this.t('access.revoke', 'Kullanıma son ver'))}</button>
              </div>
            </article>`;
        }).join('')}
      </section>` : '';

    root.innerHTML = pending + active;
    root.querySelectorAll('[data-ytlive-access-decision]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-id') || '';
        const decision = button.getAttribute('data-ytlive-access-decision') || '';
        const card = button.closest('[data-ytlive-access-request]');
        const buttons = [...(card?.querySelectorAll('[data-ytlive-access-decision]') || [])];
        if (id && ['approve', 'reject'].includes(decision)) this.decide(id, decision, buttons).catch(() => {});
      });
    });
    root.querySelectorAll('[data-ytlive-access-revoke]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-ytlive-access-revoke') || '';
        const card = button.closest('[data-ytlive-access-grant]');
        const buttons = [...(card?.querySelectorAll('[data-ytlive-access-revoke]') || [])];
        if (id) this.revoke(id, buttons).catch(() => {});
      });
    });
  }
}

export const accessInboxManager = new AccessInboxManager();
