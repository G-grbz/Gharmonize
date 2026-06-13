import { settingsManager } from './SettingsManager.js';

class YTLiveMusicApp {
  constructor() {
    this.results = [];
    this.currentItem = null;
    this.quickAddLimit = 25;
    this.resultLoadLimit = 18;
    this.formats = [];
    this.jobs = new Map();
    this.jobStreams = new Map();
    this.queuePollTimer = null;
    this.searchController = null;
    this.searchSerial = 0;
    this.activePreset = null;
    this.activeSearchQuery = '';
    this.activeSearchType = 'track';
    this.resultKeys = new Set();
    this.presetPaging = null;
    this.isLoadingMore = false;
    this.hasMoreResults = false;
    this.loadMoreObserver = null;
    this.fallbackScrollHandler = null;
    this.loadMoreCheckTimer = null;
    this.maxLoadMoreAttempts = 3;
    this.playlistTracks = [];
    this.playlistTracksSerial = 0;
    this.playlistTracksController = null;
    this.musicHomeShelves = [];
    this.musicHomeController = null;
    this.youtubePlayer = null;
    this.youtubeApiPromise = null;
    this.youtubePlaybackToken = 0;
    this.youtubeRevealTimer = null;
    this.outputSettingsKey = 'gharmonize_ytlive_output_settings';
    this.musicHomeShelfCountKey = 'gharmonize_ytlive_music_home_shelf_count';
    this.classicJobSessionKey = 'gharmonize_job_session';
    this.jobsPanelTokenKey = 'gharmonize_admin_token';
    this.outputSettings = this.loadOutputSettings();
    this.musicHomeShelfCount = this.loadMusicHomeShelfCount();
    this.presetCounters = new Map();
    this.escapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '`': '&#96;',
      '=': '&#61;',
      '/': '&#47;'
    };
  }

  async initialize() {
    try {
      await window.i18nInit?.();
    } catch (error) {
      console.warn('i18n initialization failed:', error);
    }

    window.app = {
      showNotification: (message, type = 'info') => this.notify(message, type),
      t: (key, vars) => this.t(key, vars)
    };
    window.versionManager = window.versionManager || {
      checkNow: () => this.notify(this.tt('ytlive.version.classicOnly', 'Güncelleme kontrolü klasik UI içinde kullanılabilir.'), 'info')
    };

    await settingsManager.initialize();
    this.bindEvents();
    this.applyLocalizedUi();
    await this.loadUiConfig();
    await this.loadFormats();
    this.renderFormatOptions();
    await this.refreshQueueStatus();
    this.scheduleQueuePoll();
    this.loadMusicHomeShelves();
    await this.search('', { preset: 'popular' });
  }

  bindEvents() {
    document.getElementById('settingsBtn')?.addEventListener('click', () => settingsManager.open());
    document.getElementById('themeToggle')?.addEventListener('click', () => this.toggleTheme());
    document.getElementById('searchForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = document.getElementById('searchInput')?.value || '';
      this.search(query);
    });
    const searchInput = document.getElementById('searchInput');
    searchInput?.addEventListener('focus', () => this.scrollToDiscoverSection());
    searchInput?.addEventListener('click', () => this.scrollToDiscoverSection());

    document.getElementById('playUrlBtn')?.addEventListener('click', () => this.playUrlInput());
    document.getElementById('addUrlBtn')?.addEventListener('click', () => this.addUrlInput());
    document.getElementById('addCurrentBtn')?.addEventListener('click', () => {
      if (this.currentItem) this.addItem(this.currentItem);
    });
    document.getElementById('refreshQueueBtn')?.addEventListener('click', () => this.refreshQueueStatus(true));
    document.getElementById('refreshMusicHomeBtn')?.addEventListener('click', () => this.loadMusicHomeShelves({ showToast: true }));
    this.syncMusicHomeShelfCountInput();
    document.getElementById('musicHomeShelfCountInput')?.addEventListener('change', () => this.handleMusicHomeShelfCountChange());
    document.getElementById('formatSelect')?.addEventListener('change', () => this.handleFormatChange());
    ['bitrateSelect', 'sampleRateSelect', 'includeLyrics', 'embedLyrics', 'autoZip'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => this.handleOutputSettingChange());
    });
    document.getElementById('youtubeConcurrencyInput')?.addEventListener('input', () => this.handleOutputSettingChange());

    document.querySelectorAll('[data-scroll]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelector(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    document.querySelectorAll('[data-focus]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = document.querySelector(button.dataset.focus);
        target?.focus();
      });
    });

    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.addEventListener('click', () => {
        const preset = button.dataset.preset || 'popular';
        const input = document.getElementById('searchInput');
        if (input) input.value = '';
        this.search('', { preset });
      });
    });

    document.addEventListener('i18n:applied', () => {
      this.applyLocalizedUi();
      this.renderResults();
      this.renderMusicHomeShelves();
      this.renderJobs();
      this.renderPlaylistTracks();
      this.renderQueueChip(this.getActiveJobCount());
      this.updateLoadMoreState();
      this.handleLocaleChanged();
    });

    document.getElementById('discover')?.addEventListener('click', (event) => this.handleResultInteraction(event));
    document.getElementById('discover')?.addEventListener('click', (event) => this.handleSearchTypeClick(event));
    document.getElementById('musicHomeSection')?.addEventListener('click', (event) => this.handleMusicHomeInteraction(event));
    document.getElementById('playlistTracksPanel')?.addEventListener('click', (event) => this.handlePlaylistTrackInteraction(event));
    this.setupInfiniteScroll();
  }

  async loadUiConfig() {
    try {
      const response = await fetch('/api/ui-config', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const limit = Number(data.quickAddLimit);
      if (Number.isFinite(limit) && limit > 0) {
        this.quickAddLimit = Math.max(1, Math.min(100, Math.round(limit)));
      }
    } catch (error) {
      console.warn('UI config could not be loaded:', error);
    }
  }

  loadMusicHomeShelfCount() {
    try {
      const saved = Number(localStorage.getItem(this.musicHomeShelfCountKey));
      if (Number.isFinite(saved)) return Math.max(1, Math.min(12, Math.round(saved)));
    } catch {}
    return 6;
  }

  saveMusicHomeShelfCount(value) {
    this.musicHomeShelfCount = Math.max(1, Math.min(12, Math.round(Number(value) || 6)));
    try {
      localStorage.setItem(this.musicHomeShelfCountKey, String(this.musicHomeShelfCount));
    } catch {}
    this.syncMusicHomeShelfCountInput();
  }

  syncMusicHomeShelfCountInput() {
    const input = document.getElementById('musicHomeShelfCountInput');
    if (input) input.value = String(this.musicHomeShelfCount);
  }

  handleMusicHomeShelfCountChange() {
    const input = document.getElementById('musicHomeShelfCountInput');
    this.saveMusicHomeShelfCount(input?.value || this.musicHomeShelfCount);
    this.loadMusicHomeShelves({ showToast: true });
  }

  scrollToDiscoverSection() {
    const discover = document.getElementById('discover') || document.querySelector('.content-section');
    if (!discover) return;
    requestAnimationFrame(() => {
      discover.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async loadFormats() {
    try {
      const response = await fetch('/api/formats', { cache: 'no-store' });
      const data = await response.json();
      this.formats = Array.isArray(data.formats) ? data.formats.filter((f) => !f.hidden) : [];
    } catch (error) {
      console.warn('Formats could not be loaded:', error);
      this.formats = [
        { format: 'mp3', bitrates: ['auto', '192k', '320k'], defaultBitrate: '192k', type: 'audio' },
        { format: 'mp4', bitrates: ['1080p', '720p', '480p'], defaultBitrate: '1080p', type: 'video' }
      ];
    }
  }

  renderFormatOptions() {
    const formatSelect = document.getElementById('formatSelect');
    if (!formatSelect) return;
    formatSelect.innerHTML = '';

    const formats = this.formats.length ? this.formats : [{ format: 'mp3', bitrates: ['192k'] }];
    const savedFormat = String(this.outputSettings?.format || '').toLowerCase();
    formats.forEach((format) => {
      const option = document.createElement('option');
      option.value = format.format;
      option.textContent = format.format.toUpperCase();
      formatSelect.appendChild(option);
    });

    if (formats.some((f) => f.format === savedFormat)) {
      formatSelect.value = savedFormat;
    } else if (formats.some((f) => f.format === 'mp3')) {
      formatSelect.value = 'mp3';
    }

    this.updateBitrateOptions(this.outputSettings?.bitrate);
    this.applyOutputSettings();
  }

  handleFormatChange({ save = true } = {}) {
    this.updateBitrateOptions();
    this.syncOutputAvailability();
    if (save) this.saveOutputSettings();
  }

  updateBitrateOptions(preferredBitrate = null) {
    const format = this.getSelectedFormat();
    const bitrateSelect = document.getElementById('bitrateSelect');
    const match = this.formats.find((item) => item.format === format) || {};
    const bitrates = Array.isArray(match.bitrates) && match.bitrates.length ? match.bitrates : ['auto'];
    const previousValue = String(preferredBitrate || bitrateSelect?.value || '');

    if (bitrateSelect) {
      bitrateSelect.innerHTML = '';
      bitrates.forEach((bitrate) => {
        const option = document.createElement('option');
        option.value = bitrate;
        option.textContent = bitrate === 'auto' ? 'Auto' : bitrate;
        bitrateSelect.appendChild(option);
      });
      const available = bitrates.map((bitrate) => String(bitrate));
      const fallback = String(match.defaultBitrate || bitrates[0]);
      bitrateSelect.value = available.includes(previousValue) ? previousValue : fallback;
    }
  }

  syncOutputAvailability() {
    const format = this.getSelectedFormat();
    const isVideo = this.isVideoFormat(format);
    const includeLyrics = document.getElementById('includeLyrics');
    const embedLyrics = document.getElementById('embedLyrics');
    const autoZip = document.getElementById('autoZip');
    if (includeLyrics) includeLyrics.disabled = isVideo;
    if (embedLyrics) embedLyrics.disabled = isVideo;
    if (autoZip) autoZip.disabled = isVideo;
  }

  syncLyricsControls() {
    this.syncOutputAvailability();
    this.saveOutputSettings();
  }

  handleOutputSettingChange() {
    this.syncOutputAvailability();
    this.saveOutputSettings();
  }

  applyOutputSettings() {
    const settings = this.outputSettings || {};

    const bitrateSelect = document.getElementById('bitrateSelect');
    if (bitrateSelect && settings.bitrate) {
      const value = String(settings.bitrate);
      if (Array.from(bitrateSelect.options).some((option) => option.value === value)) {
        bitrateSelect.value = value;
      }
    }

    const sampleRateSelect = document.getElementById('sampleRateSelect');
    if (sampleRateSelect && settings.sampleRate) {
      const value = String(settings.sampleRate);
      if (Array.from(sampleRateSelect.options).some((option) => option.value === value)) {
        sampleRateSelect.value = value;
      }
    }

    const youtubeConcurrency = document.getElementById('youtubeConcurrencyInput');
    if (youtubeConcurrency && Number.isFinite(Number(settings.youtubeConcurrency))) {
      youtubeConcurrency.value = String(Math.max(1, Math.min(16, Math.round(Number(settings.youtubeConcurrency)))));
    }

    [
      ['includeLyrics', 'includeLyrics'],
      ['embedLyrics', 'embedLyrics'],
      ['autoZip', 'autoCreateZip']
    ].forEach(([id, key]) => {
      const checkbox = document.getElementById(id);
      if (checkbox && typeof settings[key] === 'boolean') {
        checkbox.checked = settings[key];
      }
    });

    this.syncOutputAvailability();
  }

  loadOutputSettings() {
    try {
      const raw = localStorage.getItem(this.outputSettingsKey);
      return raw ? JSON.parse(raw) || {} : {};
    } catch {
      return {};
    }
  }

  saveOutputSettings() {
    const settings = {
      format: this.getSelectedFormat(),
      bitrate: document.getElementById('bitrateSelect')?.value || 'auto',
      sampleRate: Number(document.getElementById('sampleRateSelect')?.value || 48000),
      youtubeConcurrency: Number(document.getElementById('youtubeConcurrencyInput')?.value || 4),
      includeLyrics: !!document.getElementById('includeLyrics')?.checked,
      embedLyrics: !!document.getElementById('embedLyrics')?.checked,
      autoCreateZip: !!document.getElementById('autoZip')?.checked
    };
    this.outputSettings = settings;
    try {
      localStorage.setItem(this.outputSettingsKey, JSON.stringify(settings));
    } catch (error) {
      console.warn('Output settings could not be saved:', error);
    }
  }

  async search(rawQuery, { preset = null, type = null } = {}) {
    const query = String(rawQuery || '').trim();
    const discoverPreset = this.isDiscoverPreset(preset);
    if (!query && !discoverPreset) {
      this.setResultsStatus(this.tt('ytlive.search.needQuery', 'Arama metni gir.'));
      return;
    }

    if (!discoverPreset && type) {
      this.activeSearchType = this.normalizeSearchType(type);
    }

    this.setActivePreset(preset);
    const pagingKey = discoverPreset ? this.getPresetDisplayLabel(preset) : query;
    this.resetInfiniteResults(preset, pagingKey, { mode: discoverPreset ? 'discover' : 'search' });
    if (this.searchController) {
      this.searchController.abort();
    }
    this.searchController = new AbortController();
    const searchId = ++this.searchSerial;
    this.setResultsStatus(this.tt('ytlive.search.loading', 'Aranıyor...'));
    this.renderSkeletonResults();

    try {
      const searchType = discoverPreset
        ? (preset === 'playlist' ? 'playlist' : '')
        : this.activeSearchType;
      const result = discoverPreset
        ? await this.fetchDiscoverItems({
          preset,
          page: 1,
          signal: this.searchController.signal
        })
        : {
          items: await this.fetchSearchItems(query, {
            preset,
            type: searchType,
            signal: this.searchController.signal
          }),
          hasMore: this.canLoadMorePresetQueries()
        };
      if (searchId !== this.searchSerial) return;

      this.results = this.mergeUniqueResults(result.items, { reset: true });
      this.hasMoreResults = this.results.length > 0 && (discoverPreset ? result.hasMore : this.canLoadMorePresetQueries());
      this.renderResults();
      this.setResultsStatus(
        this.results.length
          ? this.tt('ytlive.results.count', '{count} sonuç bulundu.', { count: this.results.length })
          : searchType === 'playlist'
            ? this.tt('ytlive.results.noPlaylists', 'Çalma listesi bulunamadı.')
            : this.tt('ytlive.results.empty', 'Sonuç bulunamadı.')
      );
      this.updateLoadMoreState();
      window.setTimeout(() => this.maybeLoadMoreByScroll(), 80);

      if (this.results[0] && (preset || !this.currentItem)) {
        this.playRandomPlayerContent({ source: 'results', force: !!preset });
      } else if (!this.results.length && searchType === 'playlist') {
        this.clearPlayer(this.tt('ytlive.results.noPlaylists', 'Çalma listesi bulunamadı.'));
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      this.results = [];
      this.hasMoreResults = false;
      this.renderResults();
      this.updateLoadMoreState();
      this.setResultsStatus(this.tt('ytlive.search.error', 'Arama hatası: {message}', { message: error.message }));
      this.notify(error.message, 'error');
    }
  }

  async fetchSearchItems(query, { preset = null, type = null, signal = null, limit = this.resultLoadLimit } = {}) {
    const searchType = preset === 'playlist' ? 'playlist' : this.normalizeSearchType(type || this.activeSearchType);
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (searchType) params.set('type', searchType);
    const presetOptions = this.getPresetSearchOptions(preset);
    Object.entries(presetOptions).forEach(([key, value]) => {
      if (value) params.set(key, String(value));
    });

    const response = await fetch(`/api/youtube/search?${params}`, {
      signal,
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.search.failed', 'Arama başarısız.'));
    }

    return (Array.isArray(data.items) ? data.items : [])
      .map((item) => this.normalizeItem(item))
      .filter((item) => {
        if (!searchType) return true;
        if (searchType === 'track') return item.type === 'track';
        if (searchType === 'playlist') return this.isPlaylistLike(item) && item.type !== 'album';
        if (searchType === 'album') return item.type === 'album';
        return true;
      });
  }

  async fetchDiscoverItems({ preset = 'popular', page = 1, signal = null, limit = this.resultLoadLimit } = {}) {
    const params = new URLSearchParams({
      preset: preset || 'popular',
      page: String(page || 1),
      limit: String(limit),
      lang: this.getCurrentLang(),
      region: this.getCurrentRegion()
    });

    const response = await fetch(`/api/youtube/discover?${params}`, {
      signal,
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.search.failed', 'Arama başarısız.'));
    }

    const items = (Array.isArray(data.items) ? data.items : [])
      .map((item) => this.normalizeItem(item))
      .filter((item) => preset !== 'playlist' || this.isPlaylistLike(item));

    return {
      items,
      hasMore: !!data.hasMore
    };
  }

  async loadMusicHomeShelves({ showToast = false } = {}) {
    const section = document.getElementById('musicHomeSection');
    const status = document.getElementById('musicHomeStatus');
    if (!section) return;

    if (this.musicHomeController) {
      this.musicHomeController.abort();
    }
    this.musicHomeController = new AbortController();

    if (this.musicHomeShelves.length && status) {
      status.textContent = this.tt('ytlive.musicHome.refreshing', 'YouTube Music rafları yenileniyor...');
    }

    try {
      const params = new URLSearchParams({
        shelves: String(this.musicHomeShelfCount),
        limit: '12',
        lang: this.getCurrentLang(),
        region: this.getCurrentRegion()
      });
      const response = await fetch(`/api/youtube/music-home?${params}`, {
        signal: this.musicHomeController.signal,
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data?.error?.message || this.tt('ytlive.musicHome.failed', 'YouTube Music ana sayfası okunamadı.'));
      }

      const shelves = Array.isArray(data.shelves) ? data.shelves : [];
      this.musicHomeShelves = shelves
        .map((shelf) => ({
          title: shelf?.title || this.tt('ytlive.musicHome.shelfFallback', 'YouTube Music'),
          pinned: false,
          items: (Array.isArray(shelf?.items) ? shelf.items : [])
            .map((item) => this.normalizeItem(item))
            .filter((item) => item.webpage_url)
        }))
        .filter((shelf) => shelf.items.length);

      this.renderMusicHomeShelves();

      if (this.musicHomeShelves.length) {
        if (status) {
          status.textContent = this.tt('ytlive.musicHome.loaded', '{count} kişisel raf yüklendi.', {
            count: this.musicHomeShelves.length
          });
        }
        this.playRandomPlayerContent({ source: 'musicHome' });
        if (showToast) {
          this.notify(this.tt('ytlive.musicHome.updated', 'YouTube Music rafları yenilendi.'), 'success');
        }
        return;
      }

      section.hidden = true;
      if (showToast) {
        const message = data.warning
          ? String(data.warning)
          : data.cookieAvailable === false
          ? this.tt('ytlive.musicHome.noCookie', 'YouTube Music oturumu bulunamadı.')
          : this.tt('ytlive.musicHome.empty', 'YouTube Music kişisel raf döndürmedi.');
        this.notify(message, 'info');
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!this.musicHomeShelves.length) section.hidden = true;
      if (showToast) {
        this.notify(error.message || this.tt('ytlive.musicHome.failed', 'YouTube Music ana sayfası okunamadı.'), 'error');
      } else {
        console.warn('YouTube Music home could not be loaded:', error);
      }
    }
  }

  renderMusicHomeShelves() {
    const section = document.getElementById('musicHomeSection');
    const host = document.getElementById('musicHomeShelves');
    if (!section || !host) return;

    if (!this.musicHomeShelves.length) {
      section.hidden = true;
      host.innerHTML = '';
      return;
    }

    section.hidden = false;
    const addTitle = this.escapeHtml(this.tt('ytlive.addToQueue', 'Kuyruğa ekle'));
    const playTitle = this.escapeHtml(this.tt('ytlive.play', 'Oynat'));

    host.innerHTML = this.musicHomeShelves.map((shelf, shelfIndex) => {
      const title = this.escapeHtml(shelf.title || this.tt('ytlive.musicHome.shelfFallback', 'YouTube Music'));
      const count = this.escapeHtml(this.tt('ytlive.musicHome.itemCount', '{count} içerik', { count: shelf.items.length }));
      const items = shelf.items.map((item, index) => {
        const thumb = item.thumbnail ? this.escapeHtml(item.thumbnail) : '';
        const thumbStyle = thumb ? `style="background-image:url('${thumb.replace(/'/g, '%27')}')"` : '';
        const itemTitle = this.escapeHtml(item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
        const uploader = this.escapeHtml(item.uploader || 'YouTube Music');
        const type = this.escapeHtml(this.getItemTypeLabel(item));
        const duration = this.escapeHtml(item.duration_string || (item.duration ? this.formatSeconds(item.duration) : ''));
        const initials = this.escapeHtml(this.getTitleInitials(item.title || item.uploader || 'YT'));

        return `
          <article class="music-home-card" data-music-action="play" data-shelf="${shelfIndex}" data-index="${index}">
            <button class="music-home-card__add" type="button" data-music-action="add" data-shelf="${shelfIndex}" data-index="${index}" title="${addTitle}" aria-label="${addTitle}">+</button>
            <div class="music-home-card__thumb ${thumb ? '' : 'music-home-card__thumb--fallback'}" ${thumbStyle}>
              ${thumb ? '' : `<span>${initials}</span>`}
              ${duration ? `<span class="duration-pill">${duration}</span>` : ''}
            </div>
            <div class="music-home-card__body">
              <div class="card-kicker">
                <span class="type-pill">${type}</span>
                <span>YouTube Music</span>
              </div>
              <h3>${itemTitle}</h3>
              <p>${uploader}</p>
              <div class="card-footer">
                <span>${duration || type}</span>
                <span>${playTitle}</span>
              </div>
            </div>
          </article>
        `;
      }).join('');

      return `
        <section class="music-shelf">
          <div class="music-shelf__header">
            <h3>${title}</h3>
            <span>${count}</span>
          </div>
          <div class="music-shelf__rail">${items}</div>
        </section>
      `;
    }).join('');
  }

  renderSkeletonResults() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    this.renderDiscoverySummary({ loading: true });
    this.updateLoadMoreState('hidden');
    grid.innerHTML = Array.from({ length: 8 }).map(() => `
      <article class="content-card is-loading">
        <div class="thumb-placeholder"></div>
        <div class="line-placeholder"></div>
        <div class="line-placeholder short"></div>
      </article>
    `).join('');
  }

  renderResults() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    this.renderSearchTypeTabs();

    if (!this.results.length) {
      this.renderDiscoverySummary();
      grid.innerHTML = `<div class="empty-state full-row">${this.escapeHtml(this.tt('ytlive.results.emptyShort', 'Sonuç yok.'))}</div>`;
      return;
    }

    this.renderDiscoverySummary();
    grid.innerHTML = this.results.map((item, index) => {
      const thumb = item.thumbnail ? this.escapeHtml(item.thumbnail) : '';
      const title = this.escapeHtml(item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
      const uploader = this.escapeHtml(item.uploader || 'YouTube');
      const type = this.escapeHtml(this.getItemTypeLabel(item));
      const duration = this.escapeHtml(item.duration_string || (item.duration ? this.formatSeconds(item.duration) : ''));
      const thumbStyle = thumb ? `style="background-image:url('${thumb.replace(/'/g, '%27')}')"` : '';
      const addTitle = this.escapeHtml(this.tt('ytlive.addToQueue', 'Kuyruğa ekle'));
      const playTitle = this.escapeHtml(this.tt('ytlive.play', 'Oynat'));
      const rank = String(index + 1).padStart(2, '0');
      const tags = this.getContentTags(item, index)
        .map((tag) => `<span>${this.escapeHtml(tag)}</span>`)
        .join('');
      const sourceLabel = this.escapeHtml(this.getSourceLabel(item));
      const initials = this.escapeHtml(this.getTitleInitials(item.title || uploader || 'YT'));

      return `
        <article class="content-card" data-action="play" data-index="${index}">
          <button class="add-button" type="button" data-action="add" data-index="${index}" title="${addTitle}" aria-label="${addTitle}">+</button>
          <div class="card-thumb ${thumb ? '' : 'card-thumb--fallback'}" ${thumbStyle}>
            <span class="rank-pill">#${rank}</span>
            ${thumb ? '' : `<span class="thumb-initials">${initials}</span>`}
            ${duration ? `<span class="duration-pill">${duration}</span>` : ''}
          </div>
          <div class="content-card__body">
            <div class="card-kicker">
              <span class="type-pill">${type}</span>
              <span>${sourceLabel}</span>
            </div>
            <h3>${title}</h3>
            <p>${uploader}</p>
            ${tags ? `<div class="card-tags">${tags}</div>` : ''}
            <div class="card-footer">
              <span>${duration || type}</span>
              <span>${playTitle}</span>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  renderSearchTypeTabs() {
    const grid = document.getElementById('resultsGrid');
    if (!grid?.parentElement) return;

    let host = document.getElementById('searchTypeTabs');
    if (!host) {
      host = document.createElement('div');
      host.id = 'searchTypeTabs';
      host.className = 'search-type-tabs';
      grid.parentElement.insertBefore(host, grid);
    }

    if (!this.activeSearchQuery || this.activePreset) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    const tabs = [
      ['track', this.tt('ytlive.searchType.tracks', 'Şarkılar')],
      ['playlist', this.tt('ytlive.searchType.playlists', 'Oynatma listeleri')],
      ['album', this.tt('ytlive.searchType.albums', 'Albümler')]
    ];

    host.hidden = false;
    host.innerHTML = tabs.map(([type, label]) => `
      <button
        type="button"
        class="secondary-button compact-action ${this.activeSearchType === type ? 'is-active' : ''}"
        data-search-type="${type}">
        ${this.escapeHtml(label)}
      </button>
    `).join('');
  }

  handleSearchTypeClick(event) {
    const button = event.target.closest('[data-search-type]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();

    const type = this.normalizeSearchType(button.dataset.searchType);
    if (!type || type === this.activeSearchType || !this.activeSearchQuery) return;

    const input = document.getElementById('searchInput');
    if (input) input.value = this.activeSearchQuery;
    this.search(this.activeSearchQuery, { type });
  }

  normalizeSearchType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (['playlist', 'playlists'].includes(type)) return 'playlist';
    if (['album', 'albums'].includes(type)) return 'album';
    return 'track';
  }

  renderDiscoverySummary({ loading = false } = {}) {
    const host = this.getDiscoverySummaryHost();
    if (!host) return;

    if (loading || !this.results.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    const lead = this.results[0];
    const title = this.escapeHtml(lead.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
    const uploader = this.escapeHtml(lead.uploader || 'YouTube');
    const thumb = lead.thumbnail ? this.escapeHtml(lead.thumbnail) : '';
    const thumbStyle = thumb ? `style="background-image:url('${thumb.replace(/'/g, '%27')}')"` : '';
    const type = this.escapeHtml(this.getItemTypeLabel(lead));
    const duration = this.escapeHtml(lead.duration_string || (lead.duration ? this.formatSeconds(lead.duration) : ''));
    const presetLabel = this.escapeHtml(this.getPresetDisplayLabel(this.activePreset));
    const initials = this.escapeHtml(this.getTitleInitials(lead.title || uploader || 'YT'));
    const playlistCount = this.results.filter((item) => this.isPlaylistLike(item)).length;
    const trackCount = Math.max(0, this.results.length - playlistCount);
    const totalDuration = this.formatResultDuration(this.results);
    const addTitle = this.escapeHtml(this.tt('ytlive.addToQueue', 'Kuyruğa ekle'));
    const playTitle = this.escapeHtml(this.tt('ytlive.play', 'Oynat'));
    const miniItems = this.results.slice(1, 5).map((item, offset) => {
      const index = offset + 1;
      const itemTitle = this.escapeHtml(item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği'));
      const itemMeta = this.escapeHtml(item.uploader || this.getItemTypeLabel(item));
      const itemThumb = item.thumbnail ? this.escapeHtml(item.thumbnail) : '';
      const style = itemThumb ? `style="background-image:url('${itemThumb.replace(/'/g, '%27')}')"` : '';
      return `
        <button class="mini-result" type="button" data-action="play" data-index="${index}">
          <span class="mini-result__thumb ${itemThumb ? '' : 'mini-result__thumb--fallback'}" ${style}>
            ${itemThumb ? '' : this.escapeHtml(this.getTitleInitials(item.title || item.uploader || 'YT'))}
          </span>
          <span class="mini-result__copy">
            <strong>${itemTitle}</strong>
            <small>${itemMeta}</small>
          </span>
        </button>
      `;
    }).join('');

    host.hidden = false;
    host.innerHTML = `
      <article class="discovery-spotlight" data-action="play" data-index="0">
        <div class="spotlight-art ${thumb ? '' : 'spotlight-art--fallback'}" ${thumbStyle}>
          ${thumb ? '' : `<span>${initials}</span>`}
          ${duration ? `<span class="duration-pill">${duration}</span>` : ''}
        </div>
        <div class="spotlight-copy">
          <div class="card-kicker">
            <span class="type-pill">${type}</span>
            <span>${presetLabel}</span>
          </div>
          <h3>${title}</h3>
          <p>${uploader}</p>
          <div class="spotlight-actions">
            <button class="primary-button compact-action" type="button" data-action="play" data-index="0">${playTitle}</button>
            <button class="secondary-button compact-action" type="button" data-action="add" data-index="0" title="${addTitle}">+ ${this.escapeHtml(this.tt('ytlive.queue.title', 'Kuyruk'))}</button>
          </div>
        </div>
      </article>
      <div class="discovery-side">
        <div class="metric-grid">
          <div><strong>${this.results.length}</strong><span>${this.escapeHtml(this.tt('ytlive.content.loaded', 'içerik'))}</span></div>
          <div><strong>${trackCount}</strong><span>${this.escapeHtml(this.tt('ytlive.type.track', 'Tek parça'))}</span></div>
          <div><strong>${playlistCount}</strong><span>${this.escapeHtml(this.tt('ytlive.type.playlist', 'Çalma listesi'))}</span></div>
          <div><strong>${this.escapeHtml(totalDuration)}</strong><span>${this.escapeHtml(this.tt('ytlive.content.duration', 'süre'))}</span></div>
        </div>
        ${miniItems ? `<div class="mini-result-list">${miniItems}</div>` : ''}
      </div>
    `;
  }

  getDiscoverySummaryHost() {
    let host = document.getElementById('discoverySummary');
    if (host) return host;
    const status = document.getElementById('resultsStatus');
    if (!status?.parentElement) return null;
    host = document.createElement('div');
    host.id = 'discoverySummary';
    host.className = 'discovery-summary';
    host.hidden = true;
    status.parentElement.insertBefore(host, status);
    return host;
  }

  handleResultInteraction(event) {
    const actionButton = event.target.closest('[data-action]');
    const discover = document.getElementById('discover');
    if (!actionButton || !discover?.contains(actionButton)) return;

    const index = Number(actionButton.dataset.index);
    const item = this.results[index];
    if (!item) return;

    if (actionButton.dataset.action === 'add') {
      event.stopPropagation();
      this.addItem(item);
      return;
    }

    this.playItem(item);
  }

  handleMusicHomeInteraction(event) {
    const actionButton = event.target.closest('[data-music-action]');
    const section = document.getElementById('musicHomeSection');
    if (!actionButton || !section?.contains(actionButton)) return;

    const shelfIndex = Number(actionButton.dataset.shelf);
    const index = Number(actionButton.dataset.index);
    const item = this.musicHomeShelves[shelfIndex]?.items?.[index];
    if (!item) return;

    if (actionButton.dataset.musicAction === 'add') {
      event.stopPropagation();
      this.addItem(item);
      return;
    }

    this.playItem(item);
  }

  handlePlaylistTrackInteraction(event) {
    const actionButton = event.target.closest('[data-action]');
    const panel = document.getElementById('playlistTracksPanel');
    if (!actionButton || !panel?.contains(actionButton)) return;

    const index = Number(actionButton.dataset.index);
    const item = this.playlistTracks[index];
    if (!item) return;

    if (actionButton.dataset.action === 'playlist-add') {
      event.stopPropagation();
      this.addItem(item);
      return;
    }

    this.playItem(item, { keepPlaylist: true });
  }

  async loadPlaylistTracks(rawItem, { autoplayFirst = false } = {}) {
    const item = this.normalizeItem(rawItem);
    const panel = document.getElementById('playlistTracksPanel');
    if (!panel || !item.webpage_url) return;

    const serial = ++this.playlistTracksSerial;
    if (this.playlistTracksController) {
      this.playlistTracksController.abort();
    }
    this.playlistTracksController = new AbortController();
    this.playlistTracks = [];
    this.renderPlaylistTracks({
      loading: true,
      title: item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist')
    });

    try {
      const pageSize = 100;
      let page = 1;
      let total = 0;
      let title = item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist');
      const seen = new Set();
      let autoplayDone = false;

      while (page <= 100) {
        const response = await fetch('/api/playlist/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: item.webpage_url,
            page,
            pageSize
          }),
          signal: this.playlistTracksController.signal
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          throw new Error(data?.error?.message || this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
        }
        if (serial !== this.playlistTracksSerial) return;

        const rawEntries = Array.isArray(data.items) ? data.items : [];
        const entries = rawEntries
          .map((entry, idx) => this.normalizePlaylistEntry(entry, ((page - 1) * pageSize) + idx))
          .filter((entry) => {
            const key = this.getPlaylistTrackKey(entry);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

        total = Number(data?.playlist?.count || total || 0);
        title = data?.playlist?.title || title;
        this.playlistTracks = [...this.playlistTracks, ...entries];
        this.renderPlaylistTracks({
          loading: rawEntries.length === pageSize && (!total || this.playlistTracks.length < total),
          title,
          total
        });

        if (autoplayFirst && !autoplayDone && this.playlistTracks[0]) {
          autoplayDone = true;
          this.playItem(this.playlistTracks[0], { keepPlaylist: true });
        }

        if (!rawEntries.length || rawEntries.length < pageSize || (total && this.playlistTracks.length >= total)) {
          break;
        }
        page += 1;
      }

      this.renderPlaylistTracks({ title, total });
    } catch (error) {
      if (error.name === 'AbortError') return;
      this.renderPlaylistTracks({
        error: error.message || this.tt('ytlive.playlist.loadFailed', 'Playlist parçaları yüklenemedi.'),
        title: item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist')
      });
    }
  }

  renderPlaylistTracks({ loading = false, error = '', title = '', total = 0 } = {}) {
    const panel = document.getElementById('playlistTracksPanel');
    const titleEl = document.getElementById('playlistTracksTitle');
    const metaEl = document.getElementById('playlistTracksMeta');
    const list = document.getElementById('playlistTracksList');
    if (!panel || !titleEl || !metaEl || !list) return;

    if (!this.playlistTracks.length && !loading && !error) {
      panel.hidden = true;
      list.innerHTML = '';
      return;
    }

    panel.hidden = false;
    titleEl.textContent = title || this.tt('ytlive.playlist.tracksTitle', 'Playlist parçaları');
    if (error) {
      metaEl.textContent = error;
      list.innerHTML = `<div class="empty-state">${this.escapeHtml(error)}</div>`;
      return;
    }

    const count = this.playlistTracks.length;
    metaEl.textContent = loading
      ? this.tt('ytlive.playlist.tracksLoading', 'Playlist parçaları yükleniyor...')
      : total && total > count
        ? this.tt('ytlive.playlist.tracksCountTotal', '{count}/{total} parça', { count, total })
        : this.tt('ytlive.playlist.tracksCount', '{count} parça', { count });

    if (!count) {
      const emptyText = loading
        ? this.tt('ytlive.playlist.tracksLoading', 'Playlist parçaları yükleniyor...')
        : this.tt('ytlive.playlist.noItems', 'Playlist içinde eklenebilir parça bulunamadı.');
      list.innerHTML = `<div class="empty-state">${this.escapeHtml(emptyText)}</div>`;
      return;
    }

    const addTitle = this.escapeHtml(this.tt('ytlive.playlist.addTrack', 'Parçayı kuyruğa ekle'));
    list.innerHTML = this.playlistTracks.map((track, index) => {
      const trackTitle = this.escapeHtml(track.title || this.tt('ytlive.playlist.trackFallback', 'Parça {index}', { index: index + 1 }));
      const uploader = this.escapeHtml(track.uploader || 'YouTube');
      const duration = this.escapeHtml(track.duration_string || (track.duration ? this.formatSeconds(track.duration) : ''));
      const thumb = track.thumbnail ? this.escapeHtml(track.thumbnail) : '';
      const style = thumb ? `style="background-image:url('${thumb.replace(/'/g, '%27')}')"` : '';
      const initials = this.escapeHtml(this.getTitleInitials(track.title || uploader || 'YT'));

      return `
        <article class="playlist-track" data-action="playlist-play" data-index="${index}">
          <div class="playlist-track__index">${index + 1}</div>
          <div class="playlist-track__thumb ${thumb ? '' : 'playlist-track__thumb--fallback'}" ${style}>
            ${thumb ? '' : initials}
          </div>
          <div class="playlist-track__copy">
            <h3>${trackTitle}</h3>
            <p>${uploader}</p>
          </div>
          ${duration ? `<div class="playlist-track__duration">${duration}</div>` : ''}
          <button class="playlist-track__add" type="button" data-action="playlist-add" data-index="${index}" title="${addTitle}" aria-label="${addTitle}">+</button>
        </article>
      `;
    }).join('');
  }

  clearPlaylistTracks() {
    this.playlistTracksSerial += 1;
    if (this.playlistTracksController) {
      this.playlistTracksController.abort();
      this.playlistTracksController = null;
    }
    this.playlistTracks = [];
    this.renderPlaylistTracks();
  }

  getPlaylistTrackKey(item = {}) {
    return this.normalizeResultKey(item.id || item.webpage_url || item.url || `${item.title || ''}:${item.uploader || ''}:${item.index || ''}`);
  }

  setupInfiniteScroll() {
    const sentinel = this.getLoadMoreSentinel();
    if (!sentinel) return;

    if (this.loadMoreObserver) {
      this.loadMoreObserver.disconnect();
      this.loadMoreObserver = null;
    }
    if (this.fallbackScrollHandler) {
      window.removeEventListener('scroll', this.fallbackScrollHandler);
      window.removeEventListener('resize', this.fallbackScrollHandler);
      this.fallbackScrollHandler = null;
    }

    this.fallbackScrollHandler = () => {
      if (this.loadMoreCheckTimer) return;
      this.loadMoreCheckTimer = window.setTimeout(() => {
        this.loadMoreCheckTimer = null;
        this.maybeLoadMoreByScroll();
      }, 90);
    };
    window.addEventListener('scroll', this.fallbackScrollHandler, { passive: true });
    window.addEventListener('resize', this.fallbackScrollHandler, { passive: true });

    if ('IntersectionObserver' in window) {
      this.loadMoreObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.loadMorePresetResults();
        }
      }, { rootMargin: '720px 0px 900px', threshold: 0.01 });
      this.loadMoreObserver.observe(sentinel);
      return;
    }
  }

  getLoadMoreSentinel() {
    let sentinel = document.getElementById('resultsLoadMore');
    if (sentinel) return sentinel;
    const grid = document.getElementById('resultsGrid');
    if (!grid?.parentElement) return null;
    sentinel = document.createElement('div');
    sentinel.id = 'resultsLoadMore';
    sentinel.className = 'load-more-sentinel';
    sentinel.hidden = true;
    grid.insertAdjacentElement('afterend', sentinel);
    return sentinel;
  }

  resetInfiniteResults(preset, query, { mode = 'search' } = {}) {
    this.activePreset = preset || null;
    this.activeSearchQuery = String(query || '').trim();
    this.resultKeys = new Set();
    this.isLoadingMore = false;
    this.hasMoreResults = false;
    this.presetPaging = {
      mode,
      loadedQueries: new Set([this.normalizeResultKey(query)]),
      page: mode === 'discover' ? 1 : 0,
      failedLoads: 0
    };
    this.updateLoadMoreState('hidden');
  }

  async loadMorePresetResults() {
    if (!this.hasMoreResults || this.isLoadingMore || !this.presetPaging) return;

    this.isLoadingMore = true;
    this.updateLoadMoreState('loading');

    try {
      if (this.presetPaging.mode === 'discover') {
        const nextPage = Number(this.presetPaging.page || 1) + 1;
        const result = await this.fetchDiscoverItems({ preset: this.activePreset, page: nextPage });
        const added = this.mergeUniqueResults(result.items);

        if (added.length) {
          this.results = [...this.results, ...added];
          this.presetPaging.page = nextPage;
          this.presetPaging.failedLoads = 0;
          this.hasMoreResults = !!result.hasMore;
          this.renderResults();
          this.setResultsStatus(
            this.tt('ytlive.results.loadedMorePreset', '{count} içerik yüklendi. Kategori: {preset}', {
              count: this.results.length,
              preset: this.getPresetDisplayLabel(this.activePreset)
            })
          );
        } else {
          this.presetPaging.failedLoads += 1;
          if (!result.hasMore || this.presetPaging.failedLoads >= 2) {
            this.hasMoreResults = false;
          }
        }
        return;
      }

      let added = [];
      let lastQuery = '';
      for (let attempt = 0; attempt < this.maxLoadMoreAttempts && !added.length; attempt += 1) {
        const query = this.getNextPresetPageQuery();
        if (!query) {
          this.hasMoreResults = false;
          break;
        }
        lastQuery = query;
        const items = await this.fetchSearchItems(query, {
          preset: this.activePreset,
          type: this.activeSearchType
        });
        added = this.mergeUniqueResults(items);
      }

      if (added.length) {
        this.results = [...this.results, ...added];
        this.presetPaging.failedLoads = 0;
        this.renderResults();
        this.setResultsStatus(
          this.tt('ytlive.results.loadedMore', '{count} içerik yüklendi. Son eklenen arama: {query}', {
            count: this.results.length,
            query: lastQuery || this.activeSearchQuery
          })
        );
      } else {
        this.presetPaging.failedLoads += 1;
        if (!this.canLoadMorePresetQueries() || this.presetPaging.failedLoads >= 2) {
          this.hasMoreResults = false;
        }
      }
    } catch (error) {
      this.presetPaging.failedLoads += 1;
      this.notify(error.message || this.tt('ytlive.search.failed', 'Arama başarısız.'), 'error');
      if (this.presetPaging.failedLoads >= 2) this.hasMoreResults = false;
    } finally {
      this.isLoadingMore = false;
      this.updateLoadMoreState(this.hasMoreResults ? '' : 'done');
      window.setTimeout(() => this.maybeLoadMoreByScroll(), 80);
    }
  }

  getNextPresetPageQuery() {
    if (!this.activeSearchQuery || !this.presetPaging) return '';
    const maxAttempts = 60;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.presetPaging.page += 1;
      const query = this.activePreset
        ? this.getPresetPageQuery(this.activePreset, this.presetPaging.page)
        : this.getSearchPageQuery(this.activeSearchQuery, this.presetPaging.page);
      const key = this.normalizeResultKey(query);
      if (!this.presetPaging.loadedQueries.has(key)) {
        this.presetPaging.loadedQueries.add(key);
        return query;
      }
    }

    return '';
  }

  canLoadMorePresetQueries() {
    if (this.presetPaging?.mode === 'discover') {
      return !!this.activePreset && !!this.presetPaging;
    }
    return !!this.activeSearchQuery && !!this.presetPaging;
  }

  mergeUniqueResults(items, { reset = false } = {}) {
    if (reset) this.resultKeys = new Set();
    const unique = [];

    (Array.isArray(items) ? items : []).forEach((item) => {
      const key = this.getResultKey(item);
      if (this.resultKeys.has(key)) return;
      this.resultKeys.add(key);
      unique.push(item);
    });

    return unique;
  }

  getResultKey(item = {}) {
    const url = item.webpage_url || item.url || '';
    const id = item.id || this.getVideoId(url) || this.getPlaylistId(url);
    const type = this.isPlaylistLike(item) ? 'playlist' : 'track';
    return `${type}:${this.normalizeResultKey(id || url || `${item.title || ''}:${item.uploader || ''}`)}`;
  }

  normalizeResultKey(value) {
    return String(value || '').trim().toLowerCase();
  }

  updateLoadMoreState(state = '') {
    const sentinel = this.getLoadMoreSentinel();
    if (!sentinel) return;

    const shouldHide =
      state === 'hidden' ||
      !this.presetPaging ||
      (!this.activeSearchQuery && this.presetPaging.mode !== 'discover') ||
      !this.results.length ||
      (!this.hasMoreResults && state !== 'done');
    if (shouldHide) {
      sentinel.hidden = true;
      sentinel.classList.remove('is-loading');
      sentinel.textContent = '';
      return;
    }

    sentinel.hidden = false;
    const loading = state === 'loading' || this.isLoadingMore;
    sentinel.classList.toggle('is-loading', loading);
    sentinel.textContent = loading
      ? this.tt('ytlive.results.loadingMore', 'Yeni içerikler yükleniyor...')
      : this.hasMoreResults
        ? this.tt('ytlive.results.scrollMore', 'Daha fazla içerik için aşağı kaydır.')
        : this.tt('ytlive.results.noMore', 'Bu kategori için daha fazla öneri yok.');
  }

  maybeLoadMoreByScroll() {
    if (!this.canLoadMorePresetQueries() || !this.hasMoreResults || this.isLoadingMore) return;
    const sentinel = this.getLoadMoreSentinel();
    if (!sentinel || sentinel.hidden) return;
    const rect = sentinel.getBoundingClientRect();
    const doc = document.documentElement;
    const scrollBottom = window.scrollY + window.innerHeight;
    const nearSentinel = rect.top < window.innerHeight + 900;
    const nearDocumentBottom = scrollBottom >= (doc.scrollHeight - 1100);
    if (nearSentinel || nearDocumentBottom) {
      this.loadMorePresetResults();
    }
  }

  getMusicHomeItems() {
    return this.musicHomeShelves.flatMap((shelf) => Array.isArray(shelf.items) ? shelf.items : []);
  }

  getRandomPlayableItem(items = []) {
    const candidates = (Array.isArray(items) ? items : [])
      .map((item) => this.normalizeItem(item))
      .filter((item) => item.webpage_url);
    const embeddable = candidates.filter((item) => this.getEmbedUrl(item));
    const fallback = embeddable.length ? embeddable : candidates.filter((item) => this.isPlaylistLike(item));
    if (!fallback.length) return null;
    return fallback[Math.floor(Math.random() * fallback.length)];
  }

  playRandomPlayerContent({ source = 'results', force = false } = {}) {
    if (this.currentItem && !force) return;
    const pools = source === 'musicHome'
      ? [this.getMusicHomeItems(), this.results]
      : [this.results, this.getMusicHomeItems()];

    for (const pool of pools) {
      const item = this.getRandomPlayableItem(pool);
      if (item) {
        this.playItem(item, { silent: true });
        return;
      }
    }
  }

  playUrlInput() {
    const item = this.itemFromUrl(document.getElementById('quickUrlInput')?.value || '');
    if (!item) {
      this.notify(this.tt('ytlive.url.invalid', 'Geçerli bir YouTube linki gir.'), 'error');
      return;
    }
    this.playItem(item);
  }

  addUrlInput() {
    const item = this.itemFromUrl(document.getElementById('quickUrlInput')?.value || '');
    if (!item) {
      this.notify(this.tt('ytlive.url.invalid', 'Geçerli bir YouTube linki gir.'), 'error');
      return;
    }
    this.addItem(item);
  }

  playItem(rawItem, { silent = false, keepPlaylist = false, autoplay = true } = {}) {
    const item = this.normalizeItem(rawItem);
    const collectionLike = this.isPlaylistLike(item);

    if (collectionLike) {
      this.currentItem = item;
      this.stopYouTubePlayback();
      this.showPlayerPlaceholder(
        this.tt('ytlive.player.emptyTitle', 'Select content'),
        this.tt('ytlive.player.emptyText', 'Click a search result or pasted link to play it here.')
      );

      document.getElementById('nowType').textContent = this.getItemTypeLabel(item);
      document.getElementById('nowTitle').textContent = item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği');
      document.getElementById('nowSubtitle').textContent = item.uploader || item.webpage_url || '';

      const addCurrent = document.getElementById('addCurrentBtn');
      if (addCurrent) addCurrent.disabled = false;

      const openLink = document.getElementById('openCurrentLink');
      if (openLink) {
        openLink.href = item.webpage_url || '#';
        openLink.classList.toggle('is-disabled', !item.webpage_url);
      }

      this.loadPlaylistTracks(item, { autoplayFirst: true });
      if (!silent) this.notify(this.tt('ytlive.playlist.loading', 'Loading content...'), 'info');
      return;
    }

    const embedUrl = this.getEmbedUrl(item, { autoplay: autoplay && !silent });
    if (!embedUrl) {
      this.notify(this.tt('ytlive.play.unavailable', 'Bu içerik oynatılamıyor, ama link olarak eklenebilir.'), 'info');
      return;
    }

    this.currentItem = item;
    this.startYouTubePlayback(item, { autoplay: autoplay && !silent, silent });

    document.getElementById('nowType').textContent = this.getItemTypeLabel(item);
    document.getElementById('nowTitle').textContent = item.title || this.tt('ytlive.youtubeContent', 'YouTube içeriği');
    document.getElementById('nowSubtitle').textContent = item.uploader || item.webpage_url || '';

    const addCurrent = document.getElementById('addCurrentBtn');
    if (addCurrent) addCurrent.disabled = false;

    const openLink = document.getElementById('openCurrentLink');
    if (openLink) {
      openLink.href = item.webpage_url || '#';
      openLink.classList.toggle('is-disabled', !item.webpage_url);
    }

    if (!keepPlaylist) {
      this.clearPlaylistTracks();
    }

  }

  clearPlayer(subtitle = '') {
    this.currentItem = null;
    this.stopYouTubePlayback();
    this.showPlayerPlaceholder(
      this.tt('ytlive.player.emptyTitle', 'Select content'),
      this.tt('ytlive.player.emptyText', 'Click a search result or pasted link to play it here.')
    );

    document.getElementById('nowType').textContent = 'YouTube';
    document.getElementById('nowTitle').textContent = 'Gharmonize Music';
    document.getElementById('nowSubtitle').textContent =
      subtitle || this.tt('ytlive.now.subtitle', 'YouTube içeriklerini ara, oynat ve dönüşüm kuyruğuna ekle.');

    const addCurrent = document.getElementById('addCurrentBtn');
    if (addCurrent) addCurrent.disabled = true;

    const openLink = document.getElementById('openCurrentLink');
    if (openLink) {
      openLink.href = '#';
      openLink.classList.add('is-disabled');
    }

    this.clearPlaylistTracks();
  }

  ensureYouTubeIframeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (this.youtubeApiPromise) return this.youtubeApiPromise;

    this.youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      const timeoutId = window.setTimeout(() => reject(new Error('YouTube player API timeout')), 7000);

      window.onYouTubeIframeAPIReady = () => {
        try {
          if (typeof previousReady === 'function') previousReady();
        } catch {}
        window.clearTimeout(timeoutId);
        resolve(window.YT);
      };

      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.onerror = () => {
          window.clearTimeout(timeoutId);
          reject(new Error('YouTube player API could not be loaded'));
        };
        document.head.appendChild(script);
      }
    }).catch((error) => {
      this.youtubeApiPromise = null;
      throw error;
    });

    return this.youtubeApiPromise;
  }

  ensureYouTubePlayerHost() {
    const frame = document.querySelector('.player-frame');
    if (!frame) return null;

    let host = document.getElementById('youtubePlayer');
    if (host) {
      host.hidden = false;
      if (!host.classList.contains('youtube-player') && host.tagName !== 'IFRAME') {
        host.classList.add('youtube-player');
      }
      return host;
    }

    host = document.createElement('div');
    host.id = 'youtubePlayer';
    host.className = 'youtube-player';
    const empty = document.getElementById('playerEmpty');
    frame.insertBefore(host, empty || null);
    return host;
  }

  setYouTubePlayerVisible(visible) {
    document.querySelector('.player-frame')?.classList.toggle('is-player-visible', !!visible);
    const host = document.getElementById('youtubePlayer');
    if (host) host.hidden = false;
  }

  showPlayerPlaceholder(title, text) {
    const empty = document.getElementById('playerEmpty');
    if (!empty) return;
    const titleEl = empty.querySelector('.player-empty__title');
    const textEl = empty.querySelector('.player-empty__text');
    if (titleEl) titleEl.textContent = title || '';
    if (textEl) textEl.textContent = text || '';
    empty.hidden = false;
    empty.setAttribute('aria-hidden', 'false');
  }

  hidePlayerPlaceholder() {
    const empty = document.getElementById('playerEmpty');
    if (!empty) return;
    empty.hidden = true;
    empty.setAttribute('aria-hidden', 'true');
  }

  stopYouTubePlayback() {
    this.youtubePlaybackToken += 1;
    window.clearTimeout(this.youtubeRevealTimer);
    this.youtubeRevealTimer = null;
    this.setYouTubePlayerVisible(false);
    if (this.youtubePlayer) {
      try { this.youtubePlayer.destroy(); } catch {}
      this.youtubePlayer = null;
    }
    this.ensureYouTubePlayerHost();
    const host = document.getElementById('youtubePlayer');
    if (host) host.hidden = true;
  }

  startYouTubePlayback(item, { autoplay = true, silent = false } = {}) {
    const token = ++this.youtubePlaybackToken;
    const videoId = this.getVideoId(item?.webpage_url || item?.url || '') ||
      (String(item?.id || '').match(/^[A-Za-z0-9_-]{11}$/) ? item.id : '');
    const playlistId = this.getPlaylistId(item?.webpage_url || item?.url || '');
    const isPlaylist = this.isPlaylistLike(item) && playlistId;

    window.clearTimeout(this.youtubeRevealTimer);
    this.youtubeRevealTimer = null;
    this.setYouTubePlayerVisible(false);
    this.showPlayerPlaceholder(
      silent
        ? (item?.title || this.tt('ytlive.player.emptyTitle', 'Select content'))
        : this.tt('ytlive.player.loadingTitle', 'Loading player'),
      silent
        ? this.tt('ytlive.player.emptyText', 'Click a search result or pasted link to play it here.')
        : this.tt('ytlive.player.loadingText', 'Checking whether this video can be played here.')
    );

    if (!videoId && !isPlaylist) {
      this.showEmbedFallback(item, token, silent);
      return;
    }

    this.ensureYouTubeIframeApi()
      .then((YT) => {
        if (token !== this.youtubePlaybackToken) return;
        if (this.youtubePlayer) {
          try { this.youtubePlayer.destroy(); } catch {}
          this.youtubePlayer = null;
        }
        const host = this.ensureYouTubePlayerHost();
        if (!host) return;
        host.hidden = false;

        const playerVars = {
          autoplay: autoplay ? 1 : 0,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin
        };
        if (isPlaylist) {
          playerVars.listType = 'playlist';
          playerVars.list = playlistId;
        }

        let revealed = false;
        let notifiedPlayable = false;
        const reveal = (delay = 0) => {
          window.clearTimeout(this.youtubeRevealTimer);
          this.youtubeRevealTimer = window.setTimeout(() => {
            if (token !== this.youtubePlaybackToken) return;
            if (revealed) return;
            revealed = true;
            this.hidePlayerPlaceholder();
            this.setYouTubePlayerVisible(true);
          }, delay);
        };
        const notifyPlayable = () => {
          if (silent || notifiedPlayable) return;
          notifiedPlayable = true;
          this.notify(this.tt('ytlive.playing', 'Playing.'), 'success');
        };

        this.youtubePlayer = new YT.Player(host, {
          videoId: isPlaylist ? undefined : videoId,
          playerVars,
          events: {
            onReady: (event) => {
              if (token !== this.youtubePlaybackToken) return;
              if (autoplay) {
                try { event.target.playVideo(); } catch {}
              }
              reveal(silent ? 1800 : 900);
            },
            onStateChange: (event) => {
              if (token !== this.youtubePlaybackToken) return;
              const states = window.YT?.PlayerState || {};
              if ([states.PLAYING, states.BUFFERING, states.CUED].includes(event.data)) {
                notifyPlayable();
                reveal(120);
              }
            },
            onError: () => {
              this.showEmbedFallback(item, token, silent);
            }
          }
        });
      })
      .catch(() => {
        this.showEmbedFallback(item, token, silent);
      });
  }

  showEmbedFallback(item, token, silent = false) {
    if (token !== this.youtubePlaybackToken) return;
    window.clearTimeout(this.youtubeRevealTimer);
    this.youtubeRevealTimer = null;
    this.setYouTubePlayerVisible(false);
    if (this.youtubePlayer) {
      try { this.youtubePlayer.destroy(); } catch {}
      this.youtubePlayer = null;
    }
    this.ensureYouTubePlayerHost();
    this.showPlayerPlaceholder(
      this.tt('ytlive.player.embedBlockedTitle', 'Open on YouTube'),
      this.tt('ytlive.player.embedBlockedText', 'This video cannot be played inside Gharmonize. Use Open on YouTube or add it to the queue.')
    );
    if (!silent) {
      this.notify(this.tt('ytlive.play.embedBlocked', 'This video is blocked for embedded playback.'), 'info');
    }
  }

  async addItem(rawItem) {
    const item = this.normalizeItem(rawItem);
    if (!item.webpage_url) {
      this.notify(this.tt('ytlive.add.noUrl', 'Eklenebilir bir YouTube linki bulunamadı.'), 'error');
      return;
    }

    try {
      if (this.isPlaylistLike(item)) {
        try {
          await this.quickAddPlaylist(item);
        } catch (error) {
          if (item.type !== 'album') throw error;
          await this.submitJob(this.buildCollectionPayload(item));
        }
      } else {
        await this.submitJob(this.buildSinglePayload(item));
      }
    } catch (error) {
      this.notify(error.message || this.tt('ytlive.job.addFailed', 'İş eklenemedi.'), 'error');
    }
  }

  async quickAddPlaylist(item) {
    this.notify(
      this.tt('ytlive.playlist.preparing', 'Playlist hazırlanıyor: ilk {count} parça alınacak.', { count: this.quickAddLimit }),
      'info'
    );
    const response = await fetch('/api/playlist/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: item.webpage_url,
        page: 1,
        pageSize: this.quickAddLimit
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.playlist.readFailed', 'Playlist okunamadı.'));
    }

    const entries = (Array.isArray(data.items) ? data.items : [])
      .slice(0, this.quickAddLimit)
      .map((entry, idx) => this.normalizePlaylistEntry(entry, idx));

    if (!entries.length) {
      throw new Error(this.tt('ytlive.playlist.noItems', 'Playlist içinde eklenebilir parça bulunamadı.'));
    }

    const selectedIdsRaw = entries.map((entry) => entry.id || null);
    const selectedIds = selectedIdsRaw.every(Boolean) ? selectedIdsRaw : null;
    const selectedIndices = entries.map((entry) => entry.index);

    await this.submitJob({
      ...this.getOutputPayload(),
      url: item.webpage_url,
      isPlaylist: true,
      plTitle: data?.playlist?.title || item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist'),
      selectedIndices,
      selectedIds,
      frozenEntries: entries
    });
  }

  buildSinglePayload(item) {
    return {
      ...this.getOutputPayload(),
      url: item.webpage_url,
      isPlaylist: false,
      title: item.title || '',
      uploader: item.uploader || ''
    };
  }

  buildCollectionPayload(item) {
    return {
      ...this.getOutputPayload(),
      url: item.webpage_url,
      isPlaylist: true,
      plTitle: item.title || this.tt('ytlive.youtubePlaylist', 'YouTube Playlist')
    };
  }

  getOutputPayload() {
    const format = this.getSelectedFormat();
    const isVideo = this.isVideoFormat(format);
    return {
      format,
      bitrate: document.getElementById('bitrateSelect')?.value || 'auto',
      sampleRate: Number(document.getElementById('sampleRateSelect')?.value || 48000),
      includeLyrics: !isVideo && !!document.getElementById('includeLyrics')?.checked,
      embedLyrics: !isVideo && !!document.getElementById('embedLyrics')?.checked,
      autoCreateZip: !isVideo && !!document.getElementById('autoZip')?.checked,
      youtubeConcurrency: Number(document.getElementById('youtubeConcurrencyInput')?.value || 4)
    };
  }

  async submitJob(payload) {
    const submittedPayload = this.clonePayload(payload);
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || this.tt('ytlive.job.createFailed', 'İş oluşturulamadı.'));
    }

    this.notify(this.tt('ytlive.job.queued', 'İş kuyruğa eklendi.'), 'success');
    this.persistClassicJobSession(data, submittedPayload);
    this.trackJob(data.id);
    await this.refreshQueueStatus();
    return data;
  }

  trackJob(jobId) {
    if (!jobId || this.jobStreams.has(jobId)) return;

    const stream = new EventSource(`/api/stream/${encodeURIComponent(jobId)}`);
    this.jobStreams.set(jobId, stream);

    stream.onmessage = (event) => {
      try {
        const incoming = JSON.parse(event.data);
        const id = incoming.id || jobId;
        const job = this.mergeJobState(this.jobs.get(id), incoming);
        this.jobs.set(id, job);
        this.persistClassicJobSession(job);
        this.renderJobs();

        if (this.isTerminalJob(job)) {
          stream.close();
          this.jobStreams.delete(jobId);
          this.refreshQueueStatus();
        }
      } catch (error) {
        console.warn('Job stream parse failed:', error);
      }
    };

    stream.onerror = () => {
      stream.close();
      this.jobStreams.delete(jobId);
      this.refreshQueueStatus();
    };
  }

  async fetchQueueStatus() {
    try {
      const response = await fetch('/api/queue/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.warn('Queue status failed:', error);
      return { ok: false, activeCount: 0, activeJobs: [] };
    }
  }

  getJobsPanelToken() {
    try {
      return localStorage.getItem(this.jobsPanelTokenKey) || '';
    } catch {
      return '';
    }
  }

  async fetchJobsPanelSnapshot() {
    const token = this.getJobsPanelToken();
    if (!token) return null;

    try {
      const response = await fetch('/api/jobs?status=all', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json().catch(() => ({}));
      return Array.isArray(data.items) ? data.items : [];
    } catch (error) {
      console.warn('Jobs panel snapshot failed:', error);
      return null;
    }
  }

  async refreshQueueStatus(showToast = false) {
    const jobsPanelItems = await this.fetchJobsPanelSnapshot();
    if (jobsPanelItems) {
      this.applyJobsPanelSnapshot(jobsPanelItems);
      if (showToast) this.notify(this.tt('ytlive.queue.updated', 'Kuyruk güncellendi.'), 'success');
      return;
    }

    const status = await this.fetchQueueStatus();
    const activeJobs = Array.isArray(status.activeJobs) ? status.activeJobs : [];

    activeJobs.forEach((job) => {
      if (!job?.id) return;
      this.jobs.set(job.id, this.mergeJobState(this.jobs.get(job.id), job));
      if (!this.isTerminalJob(job)) this.trackJob(job.id);
    });

    for (const [id, job] of this.jobs.entries()) {
      if (this.isTerminalJob(job)) continue;
      if (!activeJobs.some((active) => active.id === id) && !this.jobStreams.has(id)) {
        this.jobs.delete(id);
      }
    }

    this.renderQueueChip(status.activeCount || 0);
    this.renderJobs();
    if (showToast) this.notify(this.tt('ytlive.queue.updated', 'Kuyruk güncellendi.'), 'success');
  }

  applyJobsPanelSnapshot(items = []) {
    const serverJobs = Array.isArray(items) ? items.filter((job) => job?.id) : [];
    const seen = new Set();

    serverJobs.forEach((incoming) => {
      const id = incoming.id;
      seen.add(id);
      const job = this.mergeJobState(this.jobs.get(id), incoming);
      this.jobs.set(id, job);
      this.persistClassicJobSession(job);
      if (!this.isTerminalJob(job)) this.trackJob(id);
    });

    for (const [id, job] of this.jobs.entries()) {
      if (seen.has(id) || this.jobStreams.has(id) || this.isTerminalJob(job)) continue;
      this.jobs.delete(id);
    }

    this.renderQueueChip(this.getActiveJobCount());
    this.renderJobs();
  }

  mergeJobState(prev = {}, next = {}) {
    const merged = { ...(prev || {}), ...(next || {}) };
    merged.metadata = { ...(prev?.metadata || {}), ...(next?.metadata || {}) };
    merged.playlist = { ...(prev?.playlist || {}), ...(next?.playlist || {}) };
    merged.counters = { ...(prev?.counters || {}), ...(next?.counters || {}) };
    if (next?.resultPath === undefined) merged.resultPath = prev?.resultPath;
    if (next?.zipPath === undefined) merged.zipPath = prev?.zipPath;
    if (next?.error === undefined) merged.error = prev?.error;
    return merged;
  }

  persistClassicJobSession(job = {}, payload = {}) {
    const id = job?.id;
    if (!id) return;

    try {
      const raw = localStorage.getItem(this.classicJobSessionKey);
      const session = raw ? JSON.parse(raw) : {};
      const jobs = Array.isArray(session.jobs) ? session.jobs.slice() : [];
      const index = jobs.findIndex((item) => item?.id === id);
      const previous = index >= 0 ? jobs[index] : {};
      const sessionJob = this.buildClassicSessionJob(job, payload, previous);
      const mergedJob = this.mergeJobState(previous, sessionJob);

      if (index >= 0) {
        jobs[index] = mergedJob;
      } else {
        jobs.unshift(mergedJob);
      }

      const batches = Array.isArray(session.batches) ? session.batches.slice() : [];
      const jobToBatch = session.jobToBatch && typeof session.jobToBatch === 'object'
        ? { ...session.jobToBatch }
        : {};

      if (job?.clientBatch) {
        const batchId = job.clientBatch;
        jobToBatch[id] = batchId;
        const batchIndex = batches.findIndex((batch) => batch?.id === batchId);
        const batchMeta = {
          format: sessionJob.format,
          bitrate: sessionJob.bitrate,
          source: sessionJob.metadata?.mediaPlatform || sessionJob.metadata?.source || 'youtube'
        };
        if (batchIndex >= 0) {
          const batch = batches[batchIndex] || {};
          const batchJobs = Array.isArray(batch.jobs) ? batch.jobs.slice() : [];
          if (!batchJobs.includes(id)) batchJobs.push(id);
          batches[batchIndex] = {
            ...batch,
            total: Number(job.batchTotal || batch.total || batchJobs.length || 1),
            meta: { ...(batch.meta || {}), ...batchMeta },
            jobs: batchJobs
          };
        } else {
          batches.push({
            id: batchId,
            total: Number(job.batchTotal || 1),
            meta: batchMeta,
            jobs: [id]
          });
        }
      }

      const limitedJobs = this.limitClassicSessionJobs(jobs);
      const validIds = new Set(limitedJobs.map((item) => item.id));
      const limitedBatches = batches
        .map((batch) => ({
          ...batch,
          jobs: (Array.isArray(batch.jobs) ? batch.jobs : []).filter((jobId) => validIds.has(jobId))
        }))
        .filter((batch) => batch.jobs.length);
      const limitedJobToBatch = {};
      Object.entries(jobToBatch).forEach(([jobId, batchId]) => {
        if (validIds.has(jobId)) limitedJobToBatch[jobId] = batchId;
      });

      localStorage.setItem(this.classicJobSessionKey, JSON.stringify({
        jobs: limitedJobs,
        batches: limitedBatches,
        jobToBatch: limitedJobToBatch,
        savedAt: Date.now(),
        version: 1
      }));
    } catch (error) {
      console.warn('Classic job session bridge failed:', error);
    }
  }

  buildClassicSessionJob(job = {}, payload = {}, previous = {}) {
    const now = Date.now();
    const metadata = this.buildClassicJobMetadata(job, payload, previous?.metadata || {});
    const status = this.normalizeJobStatus(job.status || previous.status || 'queued');
    const phase = this.normalizeJobStatus(job.currentPhase || job.phase || previous.currentPhase || previous.phase || status || 'queued');

    return {
      ...previous,
      ...job,
      id: job.id || previous.id,
      status,
      progress: this.safeProgress(job.progress, previous.progress, status === 'completed' ? 100 : 0),
      downloadProgress: this.safeProgress(job.downloadProgress, previous.downloadProgress, 0),
      convertProgress: this.safeProgress(job.convertProgress, previous.convertProgress, 0),
      currentPhase: phase,
      phase,
      format: job.format || payload.format || previous.format || 'mp3',
      bitrate: job.bitrate || payload.bitrate || previous.bitrate || 'auto',
      sampleRate: Number(job.sampleRate || payload.sampleRate || previous.sampleRate || 48000),
      createdAt: job.createdAt || previous.createdAt || now,
      completedAt: job.completedAt || previous.completedAt || (status === 'completed' ? now : null),
      resultPath: job.resultPath !== undefined ? job.resultPath : (previous.resultPath ?? null),
      zipPath: job.zipPath !== undefined ? job.zipPath : (previous.zipPath ?? null),
      playlist: job.playlist !== undefined ? job.playlist : (previous.playlist ?? null),
      counters: {
        ...(previous.counters || {}),
        ...(job.counters || {}),
        ...(job.metadata?.counters || {})
      },
      metadata
    };
  }

  buildClassicJobMetadata(job = {}, payload = {}, previous = {}) {
    const serverMeta = job.metadata || {};
    const rawUrl =
      payload.url ||
      serverMeta.url ||
      serverMeta.originalUrl ||
      serverMeta.extracted?.webpage_url ||
      previous.url ||
      previous.originalUrl ||
      '';
    const currentTitle = this.currentItem?.title || '';
    const title =
      serverMeta.frozenTitle ||
      payload.plTitle ||
      payload.playlistTitle ||
      payload.title ||
      currentTitle ||
      previous.frozenTitle ||
      serverMeta.extracted?.title ||
      previous.extracted?.title ||
      '';
    const frozenEntries = Array.isArray(payload.frozenEntries)
      ? payload.frozenEntries
      : (Array.isArray(serverMeta.frozenEntries) ? serverMeta.frozenEntries : previous.frozenEntries);
    const isPlaylist = Boolean(
      serverMeta.isPlaylist ||
      job.isPlaylist ||
      payload.isPlaylist ||
      (Array.isArray(frozenEntries) && frozenEntries.length > 1) ||
      this.isPlaylistUrl(rawUrl)
    );
    const mediaPlatform = serverMeta.mediaPlatform || job.mediaPlatform || previous.mediaPlatform || this.detectMediaPlatform(rawUrl);
    const source =
      serverMeta.source ||
      job.source ||
      previous.source ||
      (mediaPlatform === 'youtube' || mediaPlatform === 'dailymotion' ? 'youtube' : (rawUrl ? 'direct_url' : 'youtube'));

    return {
      ...previous,
      ...serverMeta,
      source,
      mediaPlatform,
      url: serverMeta.url || rawUrl || previous.url || '',
      originalUrl: serverMeta.originalUrl || rawUrl || previous.originalUrl || '',
      isPlaylist,
      isAutomix: Boolean(serverMeta.isAutomix || job.isAutomix || previous.isAutomix),
      frozenTitle: title || null,
      extracted: serverMeta.extracted || previous.extracted || {
        title: title || null,
        uploader: payload.uploader || previous.extracted?.uploader || null,
        webpage_url: rawUrl || null
      },
      originalName: serverMeta.originalName || previous.originalName || title || null,
      selectedIndices: payload.selectedIndices ?? serverMeta.selectedIndices ?? job.selectedIndices ?? previous.selectedIndices ?? (isPlaylist ? 'all' : null),
      selectedIds: payload.selectedIds ?? serverMeta.selectedIds ?? job.selectedIds ?? previous.selectedIds ?? null,
      frozenEntries: Array.isArray(frozenEntries) ? frozenEntries : null,
      includeLyrics: Boolean(payload.includeLyrics ?? serverMeta.includeLyrics ?? previous.includeLyrics),
      embedLyrics: Boolean(payload.embedLyrics ?? serverMeta.embedLyrics ?? previous.embedLyrics),
      autoCreateZip: Boolean(payload.autoCreateZip ?? serverMeta.autoCreateZip ?? previous.autoCreateZip)
    };
  }

  limitClassicSessionJobs(jobs = []) {
    const byId = new Map();
    jobs.forEach((job) => {
      if (!job?.id) return;
      byId.set(job.id, this.mergeJobState(byId.get(job.id), job));
    });

    const persistable = Array.from(byId.values())
      .filter((job) => !['error', 'canceled'].includes(this.normalizeJobStatus(job.status)));
    const active = persistable.filter((job) => this.normalizeJobStatus(job.status) !== 'completed');
    const completed = persistable
      .filter((job) => this.normalizeJobStatus(job.status) === 'completed')
      .sort((a, b) => Number(b.completedAt || 0) - Number(a.completedAt || 0))
      .slice(0, 15);

    return [...active, ...completed];
  }

  normalizeJobStatus(status) {
    const value = String(status || '').toLowerCase();
    return value === 'cancelled' ? 'canceled' : value;
  }

  safeProgress(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) return Math.max(0, Math.min(100, Math.round(number)));
    }
    return 0;
  }

  clonePayload(payload = {}) {
    try {
      return JSON.parse(JSON.stringify(payload || {}));
    } catch {
      return { ...(payload || {}) };
    }
  }

  detectMediaPlatform(rawUrl = '') {
    const url = String(rawUrl || '');
    if (/dailymotion\.com|dai\.ly/i.test(url)) return 'dailymotion';
    if (this.isYouTubeUrl(url)) return 'youtube';
    return null;
  }

  scheduleQueuePoll() {
    clearInterval(this.queuePollTimer);
    this.queuePollTimer = setInterval(() => this.refreshQueueStatus(), 5000);
  }

  renderQueueChip(activeCount) {
    const chip = document.getElementById('queueChip');
    if (!chip) return;
    chip.textContent = activeCount > 0
      ? this.tt('ytlive.queue.activeCount', '{count} aktif iş', { count: activeCount })
      : this.tt('ytlive.queue.empty', 'Kuyruk boş');
    chip.classList.toggle('is-busy', activeCount > 0);
  }

  renderJobs() {
    const list = document.getElementById('jobList');
    if (!list) return;

    const jobs = Array.from(this.jobs.values())
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    if (!jobs.length) {
      list.innerHTML = `<div class="empty-state">${this.escapeHtml(this.tt('ytlive.jobs.empty', 'Aktif iş yok.'))}</div>`;
      return;
    }

    list.innerHTML = jobs.map((job) => {
      const title = this.escapeHtml(this.getJobTitle(job));
      const status = this.escapeHtml(this.getJobStatusLabel(job));
      const progress = this.getJobProgress(job);
      const links = this.getJobLinks(job);

      return `
        <article class="job-card">
          <div class="job-card__top">
            <h3>${title}</h3>
            <span>${status}</span>
          </div>
          <div class="progress-bar" aria-label="İlerleme">
            <span style="width:${progress}%"></span>
          </div>
          <div class="job-card__meta">${progress}%</div>
          ${links}
        </article>
      `;
    }).join('');
  }

  getJobLinks(job) {
    if (job?.zipPath) {
      return `<a class="job-link" href="${this.escapeHtml(this.toRelative(job.zipPath))}" download>${this.escapeHtml(this.tt('ytlive.download.zip', 'ZIP indir'))}</a>`;
    }

    if (typeof job?.resultPath === 'string') {
      return `<a class="job-link" href="${this.escapeHtml(this.toRelative(job.resultPath))}" download>${this.escapeHtml(this.tt('ytlive.download.file', 'Dosyayı indir'))}</a>`;
    }

    if (Array.isArray(job?.resultPath) && job.resultPath.length) {
      const first = job.resultPath[0];
      const href = typeof first === 'string' ? first : (first.outputPath || first.path || '');
      if (href) {
        return `<a class="job-link" href="${this.escapeHtml(this.toRelative(href))}" download>${this.escapeHtml(this.tt('ytlive.download.firstFile', 'İlk dosyayı indir'))}</a>`;
      }
    }

    return '';
  }

  getJobProgress(job) {
    const status = String(job?.status || '').toLowerCase();
    if (status === 'completed') return 100;
    const progress = Number(job?.progress);
    if (Number.isFinite(progress)) return Math.max(0, Math.min(100, Math.round(progress)));
    const dl = Number(job?.downloadProgress || 0);
    const cv = Number(job?.convertProgress || 0);
    return Math.max(0, Math.min(100, Math.round((dl + cv) / 2)));
  }

  getJobTitle(job) {
    return (
      job?.metadata?.frozenTitle ||
      job?.metadata?.extracted?.title ||
      job?.metadata?.spotifyTitle ||
      job?.metadata?.originalName ||
      job?.title ||
      job?.id ||
      this.tt('ytlive.job.fallbackTitle', 'İş')
    );
  }

  getJobStatusLabel(job) {
    const phase = String(job?.currentPhase || job?.phase || job?.status || 'queued').toLowerCase();
    const labels = {
      queued: this.tt('ytlive.phase.queued', 'Sırada'),
      preparing: this.tt('ytlive.phase.preparing', 'Hazırlanıyor'),
      processing: this.tt('ytlive.phase.processing', 'İşleniyor'),
      downloading: this.tt('ytlive.phase.downloading', 'İndiriliyor'),
      converting: this.tt('ytlive.phase.converting', 'Dönüştürülüyor'),
      completed: this.tt('ytlive.phase.completed', 'Tamamlandı'),
      error: this.tt('ytlive.phase.error', 'Hata'),
      canceled: this.tt('ytlive.phase.canceled', 'İptal')
    };
    return labels[phase] || phase;
  }

  normalizeItem(item = {}) {
    let url = String(item.webpage_url || item.url || '').trim();
    const type = item.type || (this.isPlaylistUrl(url) ? 'playlist' : 'track');
    if (type === 'track') url = this.toSingleTrackUrl(url, item.id);
    return {
      ...item,
      type,
      title: item.title || (type === 'playlist' ? this.tt('ytlive.youtubePlaylist', 'YouTube Playlist') : this.tt('ytlive.youtubeVideo', 'YouTube Video')),
      webpage_url: url,
      url
    };
  }

  normalizePlaylistEntry(entry = {}, offset = 0) {
    const index = Number(entry.index || entry.playlist_index || (offset + 1));
    return {
      index,
      id: entry.id || null,
      type: 'track',
      title: entry.title || entry.id || '',
      uploader: entry.uploader || entry.channel || '',
      duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
      duration_string: entry.duration_string || null,
      thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url || null,
      webpage_url: this.normalizePlayableUrl(entry.webpage_url || entry.url || '', entry.id)
    };
  }

  itemFromUrl(rawUrl) {
    const url = this.normalizePlayableUrl(rawUrl);
    if (!url || !this.isYouTubeUrl(url)) return null;
    const playlistId = this.getPlaylistId(url);
    const videoId = this.getVideoId(url);
    const albumId = this.getAlbumBrowseId(url);
    const type = albumId ? 'album' : (playlistId && !videoId ? 'playlist' : (playlistId ? 'playlist' : 'track'));
    return {
      type,
      id: videoId || playlistId || albumId || null,
      title: type === 'album'
        ? this.tt('ytlive.type.album', 'Albüm')
        : (type === 'playlist' ? this.tt('ytlive.youtubePlaylist', 'YouTube Playlist') : this.tt('ytlive.youtubeVideo', 'YouTube Video')),
      uploader: 'YouTube',
      webpage_url: url,
      url
    };
  }

  normalizePlayableUrl(rawUrl, fallbackId = '') {
    const source = String(rawUrl || '').trim();
    if (/^https?:\/\//i.test(source)) return source;
    const id = String(fallbackId || source || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
    return source;
  }

  toSingleTrackUrl(rawUrl, fallbackId = '') {
    const source = String(rawUrl || '').trim();
    const id = this.getVideoId(source) || (String(fallbackId || '').match(/^[A-Za-z0-9_-]{11}$/) ? fallbackId : '');
    if (!id) return source;
    try {
      const url = new URL(source, window.location.origin);
      const host = /music\.youtube\.com/i.test(url.hostname) ? 'https://music.youtube.com' : 'https://www.youtube.com';
      return `${host}/watch?v=${encodeURIComponent(id)}`;
    } catch {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
  }

  getEmbedUrl(item, { autoplay = false } = {}) {
    const url = item?.webpage_url || item?.url || '';
    const playlistId = this.getPlaylistId(url);
    const videoId = this.getVideoId(url) || (String(item?.id || '').match(/^[A-Za-z0-9_-]{11}$/) ? item.id : '');

    if (this.isPlaylistLike(item) && playlistId) {
      return this.withEmbedParams('https://www.youtube.com/embed/videoseries', {
        list: playlistId,
        autoplay
      });
    }
    if (videoId) {
      return this.withEmbedParams(`https://www.youtube.com/embed/${encodeURIComponent(videoId)}`, {
        autoplay
      });
    }
    return '';
  }

  withEmbedParams(baseUrl, { autoplay = false, list = '' } = {}) {
    try {
      const url = new URL(baseUrl);
      if (list) url.searchParams.set('list', list);
      url.searchParams.set('playsinline', '1');
      url.searchParams.set('rel', '0');
      url.searchParams.set('enablejsapi', '1');
      url.searchParams.set('origin', window.location.origin);
      if (autoplay) url.searchParams.set('autoplay', '1');
      return url.toString();
    } catch {
      const params = new URLSearchParams();
      if (list) params.set('list', list);
      params.set('playsinline', '1');
      params.set('rel', '0');
      params.set('enablejsapi', '1');
      params.set('origin', window.location.origin);
      if (autoplay) params.set('autoplay', '1');
      return `${baseUrl}?${params.toString()}`;
    }
  }

  getVideoId(rawUrl) {
    const source = String(rawUrl || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(source)) return source;
    try {
      const url = new URL(source, window.location.origin);
      if (url.hostname === 'youtu.be') return url.pathname.replace(/^\/+/, '').slice(0, 11);
      if (/\/shorts\//i.test(url.pathname)) return url.pathname.split('/').filter(Boolean).pop() || '';
      return url.searchParams.get('v') || '';
    } catch {
      const match = source.match(/[?&]v=([A-Za-z0-9_-]{11})/) || source.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
      return match?.[1] || '';
    }
  }

  getPlaylistId(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), window.location.origin);
      return url.searchParams.get('list') || '';
    } catch {
      const match = String(rawUrl || '').match(/[?&]list=([^&#]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    }
  }

  getAlbumBrowseId(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), window.location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      const browseId = parts[0] === 'browse' ? parts[1] || '' : '';
      return /^MPRE/i.test(browseId) ? browseId : '';
    } catch {
      const match = String(rawUrl || '').match(/\/browse\/(MPRE[A-Za-z0-9_-]+)/i);
      return match?.[1] || '';
    }
  }

  isYouTubeUrl(url) {
    return /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i.test(String(url || ''));
  }

  isPlaylistUrl(url) {
    const value = String(url || '');
    return /(?:\/playlist|[?&]list=)/i.test(value);
  }

  isPlaylistLike(item) {
    if (item?.type === 'track') return false;
    return item?.type === 'playlist' || item?.type === 'album' || this.isPlaylistUrl(item?.webpage_url || item?.url || '');
  }

  getItemTypeLabel(item) {
    if (item?.type === 'album') return this.tt('ytlive.type.album', 'Albüm');
    if (this.isPlaylistLike(item)) return this.tt('ytlive.type.playlist', 'Çalma listesi');
    return this.tt('ytlive.type.track', 'Tek parça');
  }

  getSourceLabel(item) {
    if (this.isPlaylistLike(item)) return this.tt('ytlive.source.collection', 'Koleksiyon');
    if (String(item?.webpage_url || item?.url || '').includes('music.youtube.com')) return 'YouTube Music';
    return 'YouTube';
  }

  getContentTags(item, index = 0) {
    const tags = [];
    if (index < 3) tags.push(this.tt('ytlive.content.featured', 'Öne çıkan'));
    if (this.isPlaylistLike(item)) tags.push(this.tt('ytlive.type.playlist', 'Çalma listesi'));
    if (this.activePreset === 'new') tags.push(this.tt('ytlive.preset.new', 'Yeni'));
    if (this.activePreset === 'popular') tags.push(this.tt('ytlive.preset.popular', 'Popüler'));
    if (this.activePreset === 'local') tags.push(this.tt('ytlive.preset.local', 'Türkçe pop'));
    if (item?.duration && Number(item.duration) > 600) tags.push(this.tt('ytlive.content.longMix', 'Uzun mix'));
    return Array.from(new Set(tags)).slice(0, 3);
  }

  getTitleInitials(value) {
    const words = String(value || 'YT')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    const initials = words.map((word) => word[0]).join('').toUpperCase();
    return initials || 'YT';
  }

  formatResultDuration(items = []) {
    const seconds = (Array.isArray(items) ? items : [])
      .slice(0, 24)
      .reduce((sum, item) => sum + (Number.isFinite(Number(item?.duration)) ? Number(item.duration) : 0), 0);
    if (!seconds) return this.tt('ytlive.content.mixed', 'karma');
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours) return `${hours}s ${String(minutes).padStart(2, '0')}dk`;
    return `${Math.max(1, minutes)}dk`;
  }

  getSelectedFormat() {
    return document.getElementById('formatSelect')?.value || 'mp3';
  }

  isVideoFormat(format) {
    return ['mp4', 'mkv', 'webm'].includes(String(format || '').toLowerCase());
  }

  isTerminalJob(job) {
    return ['completed', 'error', 'canceled'].includes(String(job?.status || '').toLowerCase());
  }

  getActiveJobCount() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (!this.isTerminalJob(job)) count += 1;
    }
    return count;
  }

  applyLocalizedUi() {
    window.i18n?.apply?.(document.body);
    this.updatePresetQueries();
    const queuePanel = document.getElementById('queuePanel');
    if (queuePanel) queuePanel.dataset.collapsedLabel = this.tt('ytlive.queue.title', 'Kuyruk');

    const subtitle = document.getElementById('nowSubtitle');
    if (this.currentItem) {
      document.getElementById('nowType').textContent = this.getItemTypeLabel(this.currentItem);
      if (subtitle) subtitle.textContent = this.currentItem.uploader || this.currentItem.webpage_url || '';
    } else if (subtitle) {
      subtitle.textContent = this.tt('ytlive.now.subtitle', 'YouTube içeriklerini ara, oynat ve dönüşüm kuyruğuna ekle.');
    }
  }

  updatePresetQueries() {
    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.dataset.query = '';
    });
  }

  isDiscoverPreset(preset) {
    return ['popular', 'new', 'playlist', 'local'].includes(String(preset || '').trim().toLowerCase());
  }

  getPresetQuery(preset, { advance = false } = {}) {
    const base = this.getPresetBaseQuery(preset);
    const variants = this.getPresetQueryVariants(preset, base);
    const index = this.getPresetVariantIndex(preset, variants.length, advance);
    return variants[index] || base;
  }

  getPresetBaseQuery(preset) {
    const key = `ytlive.preset.${preset}.query`;
    const fallback = {
      popular: 'hit songs 2026 official audio',
      new: 'new songs 2026 official audio',
      playlist: 'top songs 2026 playlist',
      local: this.getLocaleDefaultMusicQuery()
    }[preset] || 'hit songs 2026 official audio';
    return this.tt(key, fallback);
  }

  getPresetSearchOptions(preset) {
    if (preset === 'new') return { sort: 'date' };
    return {};
  }

  getPresetDisplayLabel(preset) {
    if (!preset) return this.tt('ytlive.content.title', 'İçerikler');
    const fallback = {
      popular: 'Popüler',
      new: 'Yeni',
      playlist: 'Playlist',
      local: this.getLocaleDefaultMusicQuery()
    }[preset] || this.tt('ytlive.content.title', 'İçerikler');
    return this.tt(`ytlive.preset.${preset}`, fallback);
  }

  getPresetPageQuery(preset, page = 1) {
    const base = this.getPresetBaseQuery(preset);
    const variants = this.getPresetQueryVariants(preset, base);
    const safeVariants = variants.length ? variants : [base];
    const modifiers = this.getPresetPageModifiers(preset);
    const variant = safeVariants[(page - 1) % safeVariants.length];
    const modifier = modifiers[Math.floor((page - 1) / safeVariants.length) % modifiers.length] || '';
    return [variant, modifier].join(' ').replace(/\s+/g, ' ').trim();
  }

  getSearchPageQuery(baseQuery, page = 1) {
    const base = String(baseQuery || '').trim();
    const modifiers = this.getSearchPageModifiers();
    const modifier = modifiers[(page - 1) % modifiers.length] || '';
    const cycle = Math.floor((page - 1) / modifiers.length);
    const cycleSuffix = cycle ? String(2026 - (cycle % 8)) : '';
    return [base, modifier, cycleSuffix].join(' ').replace(/\s+/g, ' ').trim();
  }

  getSearchPageModifiers() {
    const lang = this.getCurrentLang();
    const modifiers = {
      tr: [
        'şarkıları',
        'en iyi şarkıları',
        'albüm',
        'konser',
        'canlı',
        'akustik',
        'klip',
        'resmi audio',
        'playlist',
        'dinle',
        'remix',
        'full albüm',
        'türküler',
        'duygusal şarkılar'
      ],
      en: [
        'songs',
        'best songs',
        'album',
        'concert',
        'live',
        'acoustic',
        'video',
        'official audio',
        'playlist',
        'listen',
        'remix',
        'full album',
        'top tracks',
        'greatest hits'
      ],
      de: [
        'songs',
        'beste songs',
        'album',
        'konzert',
        'live',
        'akustisch',
        'video',
        'offizielles audio',
        'playlist',
        'anhören',
        'remix',
        'ganzes album',
        'top titel',
        'größte hits'
      ],
      fr: [
        'chansons',
        'meilleures chansons',
        'album',
        'concert',
        'live',
        'acoustique',
        'clip',
        'audio officiel',
        'playlist',
        'écouter',
        'remix',
        'album complet',
        'meilleurs titres',
        'grands succès'
      ],
      es: [
        'canciones',
        'mejores canciones',
        'álbum',
        'concierto',
        'en vivo',
        'acústico',
        'video',
        'audio oficial',
        'playlist',
        'escuchar',
        'remix',
        'álbum completo',
        'top canciones',
        'grandes éxitos'
      ]
    };
    return modifiers[lang] || modifiers.en;
  }

  getPresetPageModifiers(preset) {
    const lang = this.getCurrentLang();
    const common = {
      tr: ['', 'resmi klip', 'resmi audio', '2026', 'bu hafta', 'top 50'],
      en: ['', 'official video', 'official audio', '2026', 'this week', 'top 50'],
      de: ['', 'offizielles video', 'offizielles audio', '2026', 'diese woche', 'top 50'],
      fr: ['', 'clip officiel', 'audio officiel', '2026', 'cette semaine', 'top 50'],
      es: ['', 'video oficial', 'audio oficial', '2026', 'esta semana', 'top 50']
    };
    const playlist = {
      tr: ['', '2026 top 50', 'yeni şarkılar', 'hit şarkılar', 'türkçe pop'],
      en: ['', '2026 top 50', 'new songs', 'hit songs', 'pop'],
      de: ['', '2026 top 50', 'neue songs', 'hit songs', 'pop'],
      fr: ['', '2026 top 50', 'nouveaux titres', 'tubes', 'pop'],
      es: ['', '2026 top 50', 'canciones nuevas', 'hits', 'pop']
    };
    const fresh = {
      tr: ['', 'bugün', 'bu hafta', 'yeni çıkan', 'resmi audio', 'resmi klip'],
      en: ['', 'today', 'this week', 'new release', 'official audio', 'official video'],
      de: ['', 'heute', 'diese woche', 'neuerscheinung', 'offizielles audio', 'offizielles video'],
      fr: ['', "aujourd'hui", 'cette semaine', 'nouveauté', 'audio officiel', 'clip officiel'],
      es: ['', 'hoy', 'esta semana', 'nuevo lanzamiento', 'audio oficial', 'video oficial']
    };
    if (preset === 'playlist') return playlist[lang] || playlist.en;
    if (preset === 'new') return fresh[lang] || fresh.en;
    return common[lang] || common.en;
  }

  getPresetVariantIndex(preset, length, advance = false) {
    if (!length) return 0;
    const current = Number(this.presetCounters.get(preset) || 0);
    const next = advance ? current + 1 : current;
    if (advance) this.presetCounters.set(preset, next);
    return next % length;
  }

  getPresetQueryVariants(preset, base) {
    const lang = this.getCurrentLang();
    const variants = {
      tr: {
        popular: ['hit şarkılar 2026 resmi audio', 'popüler şarkılar 2026 resmi klip', 'trend şarkılar 2026', 'top 50 türkçe ve dünya şarkıları'],
        new: ['yeni çıkan şarkılar 2026 resmi audio', 'bu hafta yeni çıkan şarkılar', 'yeni pop şarkılar 2026', 'son çıkan şarkılar resmi klip'],
        playlist: ['top 50 şarkılar 2026 playlist', 'hit şarkılar playlist 2026', 'yeni şarkılar playlist 2026', 'pop playlist 2026'],
        local: ['türkçe pop 2026 resmi klip', 'türkçe pop yeni şarkılar 2026', 'türkçe pop hit şarkılar 2026', 'türkiye top 50 türkçe pop']
      },
      en: {
        popular: ['hit songs 2026 official audio', 'popular songs 2026 official video', 'trending songs 2026', 'top 50 songs 2026'],
        new: ['new songs 2026 official audio', 'new releases music this week', 'new pop songs 2026', 'latest songs official video'],
        playlist: ['top songs 2026 playlist', 'hit songs playlist 2026', 'new songs playlist 2026', 'pop playlist 2026'],
        local: ['pop songs 2026 official audio', 'new pop songs 2026', 'top pop songs 2026', 'pop hits 2026']
      },
      de: {
        popular: ['hit songs 2026 offizielles audio', 'beliebte songs 2026 offizielles video', 'trend songs 2026', 'top 50 songs 2026'],
        new: ['neue songs 2026 offizielles audio', 'neue releases musik diese woche', 'neue pop songs 2026', 'aktuelle songs offizielles video'],
        playlist: ['top songs 2026 playlist', 'hit songs playlist 2026', 'neue songs playlist 2026', 'pop playlist 2026'],
        local: ['deutsche pop songs 2026 offizielles video', 'neue deutsche pop songs 2026', 'deutsche hits 2026', 'deutschland top 50 pop']
      },
      fr: {
        popular: ['tubes 2026 audio officiel', 'chansons populaires 2026 clip officiel', 'musique tendance 2026', 'top 50 chansons 2026'],
        new: ['nouveaux titres 2026 audio officiel', 'sorties musique cette semaine', 'nouvelle pop 2026', 'dernieres chansons clip officiel'],
        playlist: ['top chansons 2026 playlist', 'playlist tubes 2026', 'playlist nouveautes 2026', 'playlist pop 2026'],
        local: ['pop francaise 2026 clip officiel', 'nouveautes pop francaise 2026', 'tubes francais 2026', 'france top 50 pop']
      },
      es: {
        popular: ['canciones hits 2026 audio oficial', 'canciones populares 2026 video oficial', 'musica tendencia 2026', 'top 50 canciones 2026'],
        new: ['canciones nuevas 2026 audio oficial', 'nuevos lanzamientos musica esta semana', 'nuevo pop 2026', 'ultimas canciones video oficial'],
        playlist: ['top canciones 2026 playlist', 'playlist hits 2026', 'playlist canciones nuevas 2026', 'playlist pop 2026'],
        local: ['pop latino 2026 video oficial', 'nuevas canciones pop latino 2026', 'hits latinos 2026', 'latino top 50 pop']
      }
    };

    const list = variants[lang]?.[preset] || variants.en[preset] || [base];
    const normalized = [base, ...list].map((value) => String(value || '').trim()).filter(Boolean);
    return Array.from(new Set(normalized));
  }

  getLocaleDefaultMusicQuery() {
    const lang = this.getCurrentLang();
    const map = {
      tr: 'türkçe pop 2026 resmi klip',
      de: 'deutsche pop songs 2026 offizielles video',
      fr: 'pop francaise 2026 clip officiel',
      es: 'pop latino 2026 video oficial',
      en: 'pop songs 2026 official audio'
    };
    return map[lang] || 'pop music';
  }

  getCurrentLang() {
    const supported = new Set(['en', 'tr', 'de', 'fr', 'es']);
    const lang =
      window.i18n?.getCurrentLang?.() ||
      window.i18n?.lang ||
      localStorage.getItem('lang') ||
      navigator.language ||
      'en';
    const normalized = String(lang || 'en').toLowerCase().slice(0, 2);
    return supported.has(normalized) ? normalized : 'en';
  }

  getCurrentRegion() {
    const lang = this.getCurrentLang();
    const defaults = {
      tr: 'TR',
      de: 'DE',
      fr: 'FR',
      es: 'ES',
      en: 'US'
    };
    const candidates = [
      window.i18n?.region,
      localStorage.getItem('region')
    ];

    for (const candidate of candidates) {
      const source = String(candidate || '').trim();
      const match = source.match(/[-_]([A-Za-z]{2})\b/);
      if (match) return match[1].toUpperCase();
      if (/^[A-Za-z]{2}$/.test(source)) return source.toUpperCase();
    }

    return defaults[lang] || 'US';
  }

  handleLocaleChanged() {
    this.loadMusicHomeShelves();
    if (this.activePreset && this.isDiscoverPreset(this.activePreset)) {
      this.search('', { preset: this.activePreset });
    }
  }

  setActivePreset(preset) {
    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.classList.toggle('is-active', !!preset && button.dataset.preset === preset);
    });
  }

  setResultsStatus(message) {
    const el = document.getElementById('resultsStatus');
    if (el) el.textContent = message;
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  }

  notify(message, type = 'info') {
    const root = document.getElementById('toastRoot');
    if (!root) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = String(message || '');
    root.appendChild(toast);
    setTimeout(() => toast.classList.add('is-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  formatSeconds(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  toRelative(url) {
    if (!url) return url;
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin
        ? parsed.pathname + parsed.search + parsed.hash
        : url;
    } catch {
      return String(url).replace(/^https?:\/\/[^/]+/i, '');
    }
  }

  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"'`=\/]/g, (char) => this.escapeMap[char] || char);
  }

  t(key, vars) {
    return window.i18n?.t?.(key, vars) ?? key;
  }

  tt(key, fallback = '', vars = {}) {
    const value = this.t(key, vars);
    if (!value || value === key) {
      let out = fallback || key;
      for (const [name, replacement] of Object.entries(vars || {})) {
        out = out.replace(new RegExp(`\\{${name}\\}`, 'g'), String(replacement));
      }
      return out;
    }
    return value;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new YTLiveMusicApp();
  app.initialize().catch((error) => {
    console.error('YTLive UI initialization failed:', error);
  });
});
