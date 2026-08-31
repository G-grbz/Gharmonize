export class RetagManager {
  constructor(app) {
    this.app = app;
    this.selectedDirectory = '';
    this.desktopToken = '';
    this.storageKey = window.electronAPI
      ? 'gharmonize_retag_directory_desktop'
      : 'gharmonize_retag_directory_web';
    this.modal = null;
    this.browserState = null;
  }

  initialize() {
    try {
      this.selectedDirectory = localStorage.getItem(this.storageKey) || '';
    } catch {}

    document.getElementById('retagChooseDirectoryBtn')?.addEventListener('click', () => {
      this.chooseDirectory();
    });
    document.getElementById('outputModeSelect')?.addEventListener('change', () => this.syncUi());
    document.addEventListener('i18n:applied', () => this.syncUi());
    this.syncDirectoryLabel();
    this.syncUi();
  }

  isActive() {
    return this.app.getOutputMode() === 'retag';
  }

  syncUi() {
    const active = this.isActive();
    const container = document.getElementById('retagSettingsContainer');
    const urlInput = document.getElementById('urlInput');
    const title = document.getElementById('urlSectionTitle');
    const startButton = document.getElementById('startConvertBtn');
    let startText = startButton?.querySelector('.btn-text') || null;

    document.body.classList.toggle('retag-mode', active);
    if (container) container.style.display = active ? '' : 'none';
    if (urlInput) {
      urlInput.required = !active;
      urlInput.disabled = active;
    }
    if (title) {
      const key = active ? 'section.retag' : 'section.url';
      title.setAttribute('data-i18n', key);
      title.textContent = this.app.t(key);
    }
    if (startButton) {
      const key = active ? 'btn.retagStart' : 'btn.start';
      startButton.setAttribute('data-i18n', key);
      if (!startText) {
        Array.from(startButton.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .forEach((node) => node.remove());
        startText = document.createElement('span');
        startText.className = 'btn-text';
        startButton.appendChild(startText);
      }
      startText.textContent = this.app.t(key);
    }
    this.syncDirectoryLabel();
    this.app.setAutoZipVisibility(active ? false : this.app.shouldShowAutoZipForCurrentUI());
    this.app.musicUrlQueueManager?.updateButton?.();
  }

  syncDirectoryLabel() {
    const label = document.getElementById('retagSelectedDirectory');
    if (!label) return;
    label.textContent = this.selectedDirectory || this.app.t('ui.retagNoDirectory');
    label.classList.toggle('is-empty', !this.selectedDirectory);
  }

  setSelectedDirectory(directoryPath) {
    this.selectedDirectory = String(directoryPath || '').trim();
    try { localStorage.setItem(this.storageKey, this.selectedDirectory); } catch {}
    this.syncDirectoryLabel();
  }

  async ensureDesktopToken() {
    if (this.desktopToken) return this.desktopToken;
    try {
      const tokenInfo = await window.electronAPI?.getDesktopBridgeToken?.();
      this.desktopToken = tokenInfo?.token || '';
    } catch {}
    return this.desktopToken;
  }

  async requestHeaders({ json = false } = {}) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';

    if (window.electronAPI?.getDesktopBridgeToken) {
      const token = await this.ensureDesktopToken();
      if (token) headers['X-Gharmonize-Desktop-Token'] = token;
    } else {
      const token = localStorage.getItem('gharmonize_admin_token') || '';
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async chooseDirectory() {
    if (window.electronAPI?.selectDirectory) {
      try {
        const selected = await window.electronAPI.selectDirectory(this.selectedDirectory);
        if (selected?.canceled) return;
        if (!selected?.path) throw new Error(selected?.error || this.app.t('ui.retagNoDirectory'));
        this.setSelectedDirectory(selected.path);
      } catch (error) {
        this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
      }
      return;
    }

    this.openBrowserModal();
    await this.loadDirectories();
  }

  createBrowserModal() {
    if (this.modal) return this.modal;
    const modal = document.createElement('div');
    modal.id = 'retagDirectoryModal';
    modal.className = 'retag-directory-modal';
    modal.innerHTML = `
      <div class="retag-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="retagDirectoryModalTitle">
        <div class="retag-directory-header">
          <h3 id="retagDirectoryModalTitle" data-i18n="retag.dialog.title">Music directory</h3>
          <button type="button" class="btn-outline" data-retag-action="close" aria-label="Close">✕</button>
        </div>
        <code class="retag-directory-current" id="retagDirectoryCurrent"></code>
        <div class="retag-directory-list" id="retagDirectoryList"></div>
        <div class="retag-directory-footer">
          <button type="button" class="btn-outline" data-retag-action="parent" id="retagDirectoryParent">↩ <span data-i18n="retag.dialog.parent">Parent</span></button>
          <button type="button" class="btn-outline" data-retag-action="close" data-i18n="retag.dialog.close">Close</button>
          <button type="button" class="btn-primary" data-retag-action="select" id="retagDirectorySelect" data-i18n="retag.dialog.useDirectory">Use this directory</button>
        </div>
      </div>
    `;
    modal.addEventListener('click', (event) => this.handleModalClick(event));
    document.body.appendChild(modal);
    window.i18n?.apply?.(modal);
    this.modal = modal;
    return modal;
  }

  openBrowserModal() {
    const modal = this.createBrowserModal();
    modal.classList.add('is-open');
  }

  closeBrowserModal() {
    this.modal?.classList.remove('is-open');
  }

  async handleModalClick(event) {
    if (event.target === this.modal) {
      this.closeBrowserModal();
      return;
    }
    const button = event.target.closest('[data-retag-action]');
    if (!button) return;
    const action = button.dataset.retagAction;
    if (action === 'close') return this.closeBrowserModal();
    if (action === 'parent' && this.browserState?.parentPath) {
      return this.loadDirectories(this.browserState.parentPath);
    }
    if (action === 'open' && button.dataset.path) {
      return this.loadDirectories(button.dataset.path);
    }
    if (action === 'select' && this.browserState?.current) {
      this.setSelectedDirectory(this.browserState.current);
      this.closeBrowserModal();
    }
  }

  async loadDirectories(directoryPath = '') {
    const list = document.getElementById('retagDirectoryList');
    if (list) list.innerHTML = `<div class="retag-directory-loading">${this.app.escapeHtml(this.app.t('ui.loading'))}</div>`;

    try {
      const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : '';
      const response = await fetch(`/api/retag/directories${query}`, {
        headers: await this.requestHeaders()
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        if (response.status === 401) throw new Error(this.app.t('notif.retagAuthRequired'));
        throw new Error(data?.error?.message || `HTTP ${response.status}`);
      }
      this.browserState = data;
      this.renderDirectories();
    } catch (error) {
      this.closeBrowserModal();
      this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
    }
  }

  renderDirectories() {
    const state = this.browserState || {};
    const list = document.getElementById('retagDirectoryList');
    const current = document.getElementById('retagDirectoryCurrent');
    const parent = document.getElementById('retagDirectoryParent');
    const select = document.getElementById('retagDirectorySelect');
    if (!list || !current || !parent || !select) return;

    current.textContent = state.current || this.app.t('retag.dialog.root');
    parent.disabled = !state.parentPath;
    select.disabled = !state.current;
    const entries = state.current ? state.entries : state.roots;
    list.innerHTML = '';

    for (const entry of entries || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'retag-directory-entry';
      button.dataset.retagAction = 'open';
      button.dataset.path = entry.path;
      button.innerHTML = `<span aria-hidden="true">📁</span><span>${this.app.escapeHtml(entry.name || entry.path)}</span>`;
      list.appendChild(button);
    }

    if (!list.children.length) {
      const empty = document.createElement('div');
      empty.className = 'retag-directory-empty';
      empty.textContent = this.app.t('retag.dialog.empty');
      list.appendChild(empty);
    }
  }

  confirmStart() {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'retag-directory-modal retag-confirm-modal is-open';
      modal.innerHTML = `
        <div class="retag-directory-dialog retag-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="retagConfirmTitle" aria-describedby="retagConfirmChanges retagConfirmBackup">
          <div class="retag-directory-header">
            <h3 id="retagConfirmTitle" data-i18n="retag.confirm.title">Before retagging</h3>
            <button type="button" class="btn-outline" data-retag-confirm="cancel" aria-label="Close">✕</button>
          </div>
          <div class="retag-confirm-body">
            <p class="retag-confirm-summary" data-i18n="retag.confirm.summary">This operation updates music files in the selected directory in place.</p>
            <div class="retag-confirm-notice">
              <span class="retag-confirm-notice__icon" aria-hidden="true">🏷️</span>
              <p id="retagConfirmChanges" data-i18n="retag.confirm.changes">Online matches may not always be perfect. Tags, cover art, and filenames will be changed according to the new metadata found.</p>
            </div>
            <p id="retagConfirmBackup" class="retag-confirm-backup" data-i18n="retag.confirm.backup">Before continuing, make a copy of the directory and run this operation on the copy. After checking the result, you can delete the original directory if everything is correct.</p>
            <div class="retag-confirm-directory">
              <span data-i18n="retag.confirm.directory">Directory to process</span>
              <code>${this.app.escapeHtml(this.selectedDirectory)}</code>
            </div>
          </div>
          <div class="retag-directory-footer">
            <button type="button" class="btn-outline" data-retag-confirm="cancel" data-i18n="retag.confirm.cancel">Cancel</button>
            <button type="button" class="btn-primary" data-retag-confirm="continue" data-i18n="retag.confirm.continue">I understand, continue</button>
          </div>
        </div>
      `;

      let settled = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeyDown);
        modal.remove();
        resolve(confirmed);
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') finish(false);
      };

      modal.addEventListener('click', (event) => {
        if (event.target === modal) return finish(false);
        const action = event.target.closest('[data-retag-confirm]')?.dataset.retagConfirm;
        if (action === 'cancel') finish(false);
        if (action === 'continue') finish(true);
      });
      document.addEventListener('keydown', onKeyDown);
      document.body.appendChild(modal);
      window.i18n?.apply?.(modal);
      window.setTimeout(() => modal.querySelector('[data-retag-confirm="continue"]')?.focus(), 0);
    });
  }

  async start() {
    if (!this.selectedDirectory) {
      this.app.showNotification(this.app.t('notif.retagDirectoryRequired'), 'error', 'error');
      return;
    }

    const confirmed = await this.confirmStart();
    if (!confirmed) return;

    const response = await fetch('/api/retag/jobs', {
      method: 'POST',
      headers: await this.requestHeaders({ json: true }),
      body: JSON.stringify({ directoryPath: this.selectedDirectory })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok === false) {
      if (response.status === 401) throw new Error(this.app.t('notif.retagAuthRequired'));
      throw new Error(result?.error?.message || `HTTP ${response.status}`);
    }

    document.getElementById('job-empty')?.remove();
    this.app.jobManager.trackJob(result.id);
    this.app.jobManager.saveSessionState();
    this.app.showNotification(this.app.t('notif.retagQueued'), 'success', 'queue');
  }
}
