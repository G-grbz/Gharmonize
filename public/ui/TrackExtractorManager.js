export class TrackExtractorManager {
  constructor(app) {
    this.app = app;
    this.desktopToken = '';
    this.unsubscribeOpenEvent = null;
    this.activeEventSource = null;
  }

  async initialize() {
    this.attachHeaderButton();

    if (!window.electronAPI?.onOpenTrackExtractor) return;

    this.unsubscribeOpenEvent = window.electronAPI.onOpenTrackExtractor((payload) => {
      const files = Array.isArray(payload?.files) ? payload.files : [];
      this.openFiles(files);
    });

    try {
      const ready = await window.electronAPI.trackExtractorReady?.();
      this.desktopToken = ready?.token || this.desktopToken;
      if (!this.desktopToken && window.electronAPI.getDesktopBridgeToken) {
        const tokenInfo = await window.electronAPI.getDesktopBridgeToken();
        this.desktopToken = tokenInfo?.token || '';
      }
    } catch (error) {
      console.warn('[TrackExtractor] desktop bridge unavailable:', error);
    }
  }

  attachHeaderButton() {
    const btn = document.getElementById('trackExtractorOpenBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      if (!window.electronAPI?.selectVideoFile) {
        this.app.showNotification(
          this.app.t('trackExtractor.desktopOnly') || 'Track extractor is available in the desktop app.',
          'info',
          'default'
        );
        return;
      }

      const selected = await window.electronAPI.selectVideoFile();
      if (selected?.canceled || !selected?.path) return;
      await this.openFile(selected.path);
    });
  }

  async ensureDesktopToken() {
    if (this.desktopToken) return this.desktopToken;
    const tokenInfo = await window.electronAPI?.getDesktopBridgeToken?.();
    this.desktopToken = tokenInfo?.token || '';
    return this.desktopToken;
  }

  async postJson(url, body) {
    const token = await this.ensureDesktopToken();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gharmonize-Desktop-Token': token
      },
      body: JSON.stringify(body || {})
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      const message = data?.error?.message || data?.error || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return data;
  }

  async openFiles(files) {
    for (const filePath of files) {
      await this.openFile(filePath);
    }
  }

  async openFile(sourcePath) {
    if (!sourcePath) return;

    try {
      this.app.showNotification(
        this.app.t('trackExtractor.analyzing') || 'Video tracks are being analyzed...',
        'info',
        'progress'
      );
      const data = await this.postJson('/api/track-extractor/probe', { sourcePath });
      this.showModal(data);
    } catch (error) {
      console.error('[TrackExtractor] probe failed:', error);
      this.app.showNotification(
        `${this.app.t('notif.errorPrefix')}: ${error.message}`,
        'error',
        'error'
      );
    }
  }

  typeLabel(type) {
    const key = `trackExtractor.type.${type}`;
    const fallback = type === 'audio'
      ? 'Audio'
      : type === 'subtitle'
        ? 'Subtitle'
        : type === 'video'
          ? 'Video'
          : type === 'image'
            ? 'Images'
            : type === 'chapters'
              ? 'Chapters'
              : type;
    const translated = this.app.t(key);
    return translated && translated !== key ? translated : fallback;
  }

  formatTrackMeta(track) {
    if (track.type === 'chapters') {
      return [
        track.chapterCount ? `${track.chapterCount} chapters` : '',
        track.codec || ''
      ].filter(Boolean).join(' · ');
    }

    if (track.type === 'image') {
      return [
        track.codec || '',
        track.mimeType || '',
        track.width && track.height ? `${track.width}x${track.height}` : '',
        track.attachedPic ? 'attached pic' : '',
        track.originalFilename || ''
      ].filter(Boolean).join(' · ');
    }

    const parts = [
      `${(track.language || 'und').toUpperCase()}`,
      track.codec || '',
      track.channels ? `${track.channels}ch` : '',
      track.height ? `${track.width || ''}x${track.height}` : '',
      track.fps ? `${track.fps} FPS` : '',
      track.default ? (this.app.t('streamSelection.default') || 'Default') : '',
      track.forced ? (this.app.t('streamSelection.forced') || 'Forced') : ''
    ].filter(Boolean);
    return parts.join(' · ');
  }

  renderTrackGroup(type, tracks) {
    if (!tracks.length) return '';
    return `
      <section class="track-extractor-section">
        <div class="track-extractor-section__title">${this.app.escapeHtml(this.typeLabel(type))}</div>
        <div class="track-extractor-list">
          ${tracks.map((track) => `
            <label class="track-extractor-item">
              <input type="checkbox" class="track-extractor-checkbox" value="${track.index}" checked>
              <span class="track-extractor-item__main">
                <span class="track-extractor-item__name">${this.app.escapeHtml(track.outputName)}</span>
                <span class="track-extractor-item__meta">${this.app.escapeHtml(this.formatTrackMeta(track))}</span>
                ${track.title ? `<span class="track-extractor-item__title">${this.app.escapeHtml(track.title)}</span>` : ''}
              </span>
            </label>
          `).join('')}
        </div>
      </section>
    `;
  }

  showModal(data) {
    const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
    if (!tracks.length) {
      this.app.showNotification(
        this.app.t('trackExtractor.noTracks') || 'No extractable tracks found.',
        'error',
        'error'
      );
      return;
    }

    const byType = {
      video: tracks.filter((track) => track.type === 'video'),
      audio: tracks.filter((track) => track.type === 'audio'),
      subtitle: tracks.filter((track) => track.type === 'subtitle'),
      image: tracks.filter((track) => track.type === 'image'),
      chapters: tracks.filter((track) => track.type === 'chapters')
    };

    const backdrop = this.app.modalManager.modalContainer;
    const modal = document.createElement('div');
    modal.className = 'custom-modal custom-modal--info track-extractor-modal';
    modal.innerHTML = `
      <div class="custom-modal__header">
        <div class="custom-modal__icon">✂</div>
        <div class="custom-modal__content">
          <h3 class="custom-modal__title">${this.app.escapeHtml(this.app.t('trackExtractor.title') || 'Track Extractor')}</h3>
          <div class="track-extractor-file">${this.app.escapeHtml(data.fileName || data.sourcePath || '')}</div>
          <div class="custom-modal__message">
            <div class="track-extractor-actions">
              <button type="button" class="btn-outline" id="trackExtractorSelectAll">${this.app.escapeHtml(this.app.t('trackExtractor.selectAll') || 'Select all')}</button>
              <button type="button" class="btn-outline" id="trackExtractorClearAll">${this.app.escapeHtml(this.app.t('trackExtractor.clearAll') || 'Clear')}</button>
            </div>
            <div class="track-extractor-body">
              ${this.renderTrackGroup('video', byType.video)}
              ${this.renderTrackGroup('audio', byType.audio)}
              ${this.renderTrackGroup('subtitle', byType.subtitle)}
              ${this.renderTrackGroup('image', byType.image)}
              ${this.renderTrackGroup('chapters', byType.chapters)}
            </div>
            <div class="track-extractor-progress" id="trackExtractorProgress" hidden>
              <div class="progress-container">
                <div class="progress-bar">
                  <div class="progress-fill" id="trackExtractorProgressFill" style="width:0%"></div>
                  <div class="progress-overlay" id="trackExtractorProgressOverlay">0%</div>
                </div>
                <div class="progress-text" id="trackExtractorProgressText">${this.app.escapeHtml(this.app.t('disc.progress.ready') || 'Ready')}</div>
              </div>
            </div>
            <div class="track-extractor-results" id="trackExtractorResults" hidden></div>
          </div>
        </div>
      </div>
      <div class="custom-modal__footer">
        <button class="modal-btn modal-btn-cancel" type="button">${this.app.escapeHtml(this.app.t('btn.cancel') || 'Cancel')}</button>
        <button class="modal-btn modal-btn-confirm" type="button">${this.app.escapeHtml(this.app.t('trackExtractor.extractSelected') || 'Extract selected')}</button>
      </div>
    `;

    const cleanup = () => {
      if (this.activeEventSource) {
        this.activeEventSource.close();
        this.activeEventSource = null;
      }
      if (modal.parentNode) modal.parentNode.removeChild(modal);
      if (backdrop && backdrop.children.length === 0) {
        backdrop.style.display = 'none';
        backdrop.classList.remove('is-open');
      }
      document.removeEventListener('keydown', escHandler);
      backdrop.removeEventListener('click', backdropHandler);
    };

    const escHandler = (event) => {
      if (event.key === 'Escape') cleanup();
    };
    const backdropHandler = (event) => {
      if (event.target === backdrop) cleanup();
    };

    const checkboxes = () => Array.from(modal.querySelectorAll('.track-extractor-checkbox'));
    modal.querySelector('#trackExtractorSelectAll')?.addEventListener('click', () => {
      checkboxes().forEach((checkbox) => { checkbox.checked = true; });
    });
    modal.querySelector('#trackExtractorClearAll')?.addEventListener('click', () => {
      checkboxes().forEach((checkbox) => { checkbox.checked = false; });
    });
    modal.querySelector('.modal-btn-cancel')?.addEventListener('click', cleanup);
    modal.querySelector('.modal-btn-confirm')?.addEventListener('click', () => {
      this.startExtraction(modal, data);
    });

    document.addEventListener('keydown', escHandler);
    backdrop.addEventListener('click', backdropHandler);
    backdrop.style.display = 'flex';
    backdrop.classList.add('is-open');
    backdrop.appendChild(modal);
  }

  async startExtraction(modal, data) {
    const selected = Array.from(modal.querySelectorAll('.track-extractor-checkbox:checked'))
      .map((checkbox) => Number(checkbox.value))
      .filter(Number.isFinite);

    if (!selected.length) {
      this.app.showNotification(
        this.app.t('trackExtractor.pickTrack') || 'Select at least one track.',
        'error',
        'error'
      );
      return;
    }

    const confirmBtn = modal.querySelector('.modal-btn-confirm');
    const cancelBtn = modal.querySelector('.modal-btn-cancel');
    const progress = modal.querySelector('#trackExtractorProgress');
    const progressFill = modal.querySelector('#trackExtractorProgressFill');
    const progressOverlay = modal.querySelector('#trackExtractorProgressOverlay');
    const progressText = modal.querySelector('#trackExtractorProgressText');

    try {
      confirmBtn.disabled = true;
      modal.querySelectorAll('.track-extractor-checkbox, #trackExtractorSelectAll, #trackExtractorClearAll')
        .forEach((el) => { el.disabled = true; });
      progress.hidden = false;
      progressText.textContent = this.app.t('trackExtractor.queued') || 'Queued...';

      const result = await this.postJson('/api/track-extractor/extract', {
        sourcePath: data.sourcePath,
        tracks: selected
      });

      this.app.jobManager.trackJob(result.id);
      this.watchExtractionJob(result.id, {
        outputSubdir: result.outputSubdir,
        progressFill,
        progressOverlay,
        progressText,
        resultsEl: modal.querySelector('#trackExtractorResults'),
        cancelBtn
      });
    } catch (error) {
      confirmBtn.disabled = false;
      modal.querySelectorAll('.track-extractor-checkbox, #trackExtractorSelectAll, #trackExtractorClearAll')
        .forEach((el) => { el.disabled = false; });
      this.app.showNotification(
        `${this.app.t('notif.errorPrefix')}: ${error.message}`,
        'error',
        'error'
      );
    }
  }

  watchExtractionJob(jobId, ui) {
    if (this.activeEventSource) {
      this.activeEventSource.close();
      this.activeEventSource = null;
    }

    const eventSource = new EventSource(`/api/stream/${jobId}`);
    this.activeEventSource = eventSource;

    eventSource.onmessage = (event) => {
      const job = JSON.parse(event.data);
      const progress = Math.max(0, Math.min(100, Number(job.progress || job.convertProgress || 0)));
      ui.progressFill.style.width = `${progress}%`;
      ui.progressOverlay.textContent = `${Math.floor(progress)}%`;
      ui.progressText.textContent = job.lastLog || job.currentPhase || '';

      if (job.status === 'completed') {
        eventSource.close();
        this.activeEventSource = null;
        this.renderResults(job, ui);
        this.app.showNotification(
          this.app.t('trackExtractor.completed') || 'Tracks extracted.',
          'success',
          'queue'
        );
      } else if (job.status === 'error' || job.status === 'canceled') {
        eventSource.close();
        this.activeEventSource = null;
        ui.progressText.textContent = job.error || job.lastLog || job.status;
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      if (this.activeEventSource === eventSource) this.activeEventSource = null;
    };
  }

  renderResults(job, ui) {
    const results = Array.isArray(job.resultPath) ? job.resultPath : [];
    ui.resultsEl.hidden = false;
    ui.resultsEl.innerHTML = `
      <div class="track-extractor-results__title">${this.app.escapeHtml(this.app.t('trackExtractor.outputs') || 'Outputs')}</div>
      <div class="track-extractor-output-list">
        ${results.map((item) => `
          <a class="download-btn" href="${this.app.escapeHtml(item.outputPath || item.path || '#')}">
            ${this.app.escapeHtml(item.filename || item.outputPath || item.path || '')}
          </a>
        `).join('')}
      </div>
      <button type="button" class="btn-outline track-extractor-open-folder">${this.app.escapeHtml(this.app.t('btn.openOutputFolder') || 'Open output folder')}</button>
    `;

    ui.resultsEl.querySelector('.track-extractor-open-folder')?.addEventListener('click', async () => {
      const subdir = job.metadata?.outputSubdir || ui.outputSubdir || '';
      const opened = await window.electronAPI?.openOutputFolder?.(subdir);
      if (!opened?.success) {
        this.app.showNotification(
          `${this.app.t('notif.errorPrefix')}: ${opened?.error || 'open folder failed'}`,
          'error',
          'error'
        );
      }
    });
  }
}
