export class VideoSettingsManager {
  constructor(app) {
    this.app = app;
    this.ffmpegCaps = null;

    this.videoSettings = {
      transcodeEnabled: false,
      audioTranscodeEnabled: false,
      scaleMode: 'auto',
      targetWidth: '',
      heightMode: 'auto',
      targetHeight: '',
      allowUpscale: false,
      orientation: 'auto',
      resizeMode: 'scale',
      cropEnabled: false,
      cropLeft: '0',
      cropRight: '0',
      cropTop: '0',
      cropBottom: '0',
      borderEnabled: false,
      borderSize: '0',
      borderColor: '#000000',
      swSettings: {
        preset: 'veryfast',
        quality: '23',
        profile: 'high',
        level: '4.0',
        tune: ''
      },

      colorRange: 'auto',
      colorPrimaries: 'auto',
      hdrMode: 'auto',
      hdrToneMapping: 'hable',
      hdrPeakBrightness: '1000',
      hwaccel: 'off',
      fps: 'source',
      videoCodec: 'auto',
      proresProfile: '2',

      nvencSettings: {
        preset: 'p4',
        tune: 'hq',
        quality: '23',
        profile: 'high',
        level: '4.0'
      },

      qsvSettings: {
        preset: 'veryfast',
        quality: '26',
        profile: 'main',
        level: 'auto',
        tune: ''
      },

      vaapiSettings: {
        device: '/dev/dri/renderD128',
        quality: '26',
        profile: 'main',
        level: 'auto',
        tune: ''
      },

      audioCodec: 'aac',
      audioChannels: 'original',
      audioSampleRate: '48000',
      audioBitrate: '192k',
      volumeGain: 1.0
    };

    this.modalEl = null;
    this.backdropEl = null;
    this.modalOpen = false;
    this.pendingOpenFromCheckbox = false;
    this.tuneOptions = {
      h264: [
        { value: 'film', labelKey: 'option.tune.film', fallback: 'Film (Live action content)' },
        { value: 'animation', labelKey: 'option.tune.animation', fallback: 'Animation (Cartoons, anime)' },
        { value: 'grain', labelKey: 'option.tune.grain', fallback: 'Grain (Preserve grain structure)' },
        { value: 'stillimage', labelKey: 'option.tune.stillimage', fallback: 'Still Image (Slideshows)' },
        { value: 'fastdecode', labelKey: 'option.tune.fastdecode', fallback: 'Fast Decode' },
        { value: 'zerolatency', labelKey: 'option.tune.zerolatency', fallback: 'Zero Latency' },
        { value: 'psnr', labelKey: 'option.tune.psnr', fallback: 'PSNR (Quality testing)' },
        { value: 'ssim', labelKey: 'option.tune.ssim', fallback: 'SSIM (Quality testing)' }
      ],
      h265: [
        { value: 'grain', labelKey: 'option.tune.grain', fallback: 'Grain (Preserve grain structure)' },
        { value: 'fastdecode', labelKey: 'option.tune.fastdecode', fallback: 'Fast Decode' },
        { value: 'zerolatency', labelKey: 'option.tune.zerolatency', fallback: 'Zero Latency' },
        { value: 'psnr', labelKey: 'option.tune.psnr', fallback: 'PSNR (Quality testing)' },
        { value: 'ssim', labelKey: 'option.tune.ssim', fallback: 'SSIM (Quality testing)' }
      ],
      nvenc: [
        { value: 'hq', labelKey: 'option.tune.nvenc.hq', fallback: 'HQ (High Quality)' },
        { value: 'll', labelKey: 'option.tune.nvenc.ll', fallback: 'LL (Low Latency)' },
        { value: 'ull', labelKey: 'option.tune.nvenc.ull', fallback: 'ULL (Ultra Low Latency)' },
        { value: 'lossless', labelKey: 'option.tune.nvenc.lossless', fallback: 'Lossless (Lossless encoding)' }
      ],
      default: []
    };

    this.profileOptions = {
      h264: [
        { value: 'baseline', labelKey: 'option.profile.baseline', fallback: 'Baseline (Mobile devices)' },
        { value: 'main', labelKey: 'option.profile.main', fallback: 'Main (Standard definition)' },
        { value: 'high', labelKey: 'option.profile.high', fallback: 'High (HD video)' }
      ],
      h265: [
        { value: 'main', labelKey: 'option.profile.main', fallback: 'Main (8-bit, 4:2:0)' },
        { value: 'main10', labelKey: 'option.profile.main10', fallback: 'Main 10 (10-bit, 4:2:0)' }
      ],
      av1: [
        { value: 'main', labelKey: 'option.profile.main', fallback: 'Main (8/10-bit, 4:2:0)' }
      ],
      vp9: [
        { value: '0', labelKey: 'option.profile.profile0', fallback: 'Profile 0 (8-bit, 4:2:0)' },
        { value: '2', labelKey: 'option.profile.profile2', fallback: 'Profile 2 (10/12-bit, 4:2:0)' }
      ],
      default: [
        { value: 'main', labelKey: 'option.profile.main', fallback: 'Main' },
        { value: 'high', labelKey: 'option.profile.high', fallback: 'High' }
      ]
    };

    this.profileOptions.h264_10bit = [
      { value: 'high10', labelKey: 'option.profile.high10', fallback: 'High 10 (10-bit)' }
    ];

    this.levelOptions = [
      { value: '1.0', labelKey: 'option.level.1.0', fallback: 'Level 1.0 (QCIF, 176x144)' },
      { value: '1.3', labelKey: 'option.level.1.3', fallback: 'Level 1.3 (CIF, 352x288)' },
      { value: '2.0', labelKey: 'option.level.2.0', fallback: 'Level 2.0 (CIF, 352x288)' },
      { value: '2.2', labelKey: 'option.level.2.2', fallback: 'Level 2.2 (480p, 720x480)' },
      { value: '3.0', labelKey: 'option.level.3.0', fallback: 'Level 3.0 (SD, 720x576)' },
      { value: '3.1', labelKey: 'option.level.3.1', fallback: 'Level 3.1 (720p, 1280x720)' },
      { value: '3.2', labelKey: 'option.level.3.2', fallback: 'Level 3.2 (720p, 1280x720)' },
      { value: '4.0', labelKey: 'option.level.4.0', fallback: 'Level 4.0 (1080p, 1920x1080)' },
      { value: '4.1', labelKey: 'option.level.4.1', fallback: 'Level 4.1 (1080p, 1920x1080)' },
      { value: '4.2', labelKey: 'option.level.4.2', fallback: 'Level 4.2 (2K, 2048x1080)' },
      { value: '5.0', labelKey: 'option.level.5.0', fallback: 'Level 5.0 (4K, 3840x2160)' },
      { value: '5.1', labelKey: 'option.level.5.1', fallback: 'Level 5.1 (4K, 3840x2160)' },
      { value: '5.2', labelKey: 'option.level.5.2', fallback: 'Level 5.2 (4K, 3840x2160)' },
      { value: '6.0', labelKey: 'option.level.6.0', fallback: 'Level 6.0 (8K, 7680x4320)' },
      { value: '6.1', labelKey: 'option.level.6.1', fallback: 'Level 6.1 (8K, 7680x4320)' },
      { value: '6.2', labelKey: 'option.level.6.2', fallback: 'Level 6.2 (8K, 7680x4320)' },
      { value: 'auto', labelKey: 'option.level.auto', fallback: 'Auto (FFmpeg default)' }
    ];
    if (typeof window !== 'undefined' && window.i18n?.on) {
      try {
        window.i18n.on('languageChanged', () => {
          if (typeof this.handleLanguageChanged === 'function') {
            this.handleLanguageChanged();
          }
        });
      } catch (e) {
        console.warn('[VideoSettingsManager] Failed to bind languageChanged listener:', e);
      }
    }
  }

  setDisabled(el, disabled) {
    if (!el) return;
    el.disabled = !!disabled;
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT') {
      el.style.opacity = disabled ? '0.55' : '';
      el.style.pointerEvents = disabled ? 'none' : '';
    }
  }

  setFfmpegCaps(caps) {
    this.ffmpegCaps = caps || null;

    if (this.modalOpen && this.modalEl) {
      this.updateVideoCodecOptions();
      const hw = this.videoSettings.hwaccel || 'off';
      const codec = this.videoSettings.videoCodec || 'auto';
      if (codec !== 'auto' && codec !== 'copy') this.updateEncoderSpecificOptions(codec, hw);
    }
  }

  t(key, fallback = '') {
    try {
      const val = window?.i18n?.t?.(key);
      return (val && val !== key) ? val : fallback;
    } catch {
      return fallback;
    }
  }

  initialize() {
    this.loadFromStorage();

    if (this.app) {
      this.app.currentVolumeGain = this.videoSettings.volumeGain ?? 1.0;
    }

    this.createUI();
    this.attachEvents();
    this.allowedToneMappings = new Set(['hable', 'mobius', 'reinhard']);
  }

  normalizeHdrToneMapping() {
    const cur = String(this.videoSettings.hdrToneMapping || '').toLowerCase();
    if (!this.allowedToneMappings.has(cur)) {
      this.videoSettings.hdrToneMapping = 'hable';
    }
  }

  loadFromStorage() {
    const saved = localStorage.getItem('videoSettings');
    if (!saved) return;

    try {
      this.videoSettings = { ...this.videoSettings, ...JSON.parse(saved) };
      this.videoSettings.transcodeEnabled = !!this.videoSettings.transcodeEnabled;
      this.videoSettings.audioTranscodeEnabled = !!this.videoSettings.audioTranscodeEnabled;
      this.videoSettings.hwaccel = this.videoSettings.hwaccel || 'off';
      this.videoSettings.fps = this.videoSettings.fps || 'source';
      this.videoSettings.scaleMode = this.videoSettings.scaleMode || 'auto';
      this.videoSettings.targetWidth = this.videoSettings.targetWidth ?? '';
      this.videoSettings.heightMode = this.videoSettings.heightMode || 'auto';
      this.videoSettings.targetHeight = this.videoSettings.targetHeight ?? '';
      this.videoSettings.allowUpscale = !!this.videoSettings.allowUpscale;
      this.videoSettings.hdrMode = this.videoSettings.hdrMode || 'auto';
      this.videoSettings.hdrToneMapping = this.videoSettings.hdrToneMapping || 'hable';
      this.videoSettings.hdrPeakBrightness = String(this.videoSettings.hdrPeakBrightness || '1000');
      this.normalizeHdrToneMapping();

      this.videoSettings.orientation = this.videoSettings.orientation || 'auto';
      this.videoSettings.resizeMode = this.videoSettings.resizeMode || 'scale';
      this.videoSettings.cropEnabled = !!this.videoSettings.cropEnabled;
      this.videoSettings.cropLeft = String(this.videoSettings.cropLeft ?? '0');
      this.videoSettings.cropRight = String(this.videoSettings.cropRight ?? '0');
      this.videoSettings.cropTop = String(this.videoSettings.cropTop ?? '0');
      this.videoSettings.cropBottom = String(this.videoSettings.cropBottom ?? '0');
      this.videoSettings.borderEnabled = !!this.videoSettings.borderEnabled;
      this.videoSettings.borderSize = String(this.videoSettings.borderSize ?? '0');
      this.videoSettings.borderColor = String(this.videoSettings.borderColor ?? '#000000');

      this.videoSettings.videoCodec = this.videoSettings.videoCodec || 'auto';
      this.videoSettings.proresProfile = String(this.videoSettings.proresProfile ?? '2');
      this.videoSettings.audioCodec = this.videoSettings.audioCodec || 'aac';
      this.videoSettings.audioBitrate = this.videoSettings.audioBitrate || '192k';
      this.videoSettings.audioChannels = this.videoSettings.audioChannels || 'original';
      this.videoSettings.audioSampleRate = this.videoSettings.audioSampleRate || '48000';
      this.videoSettings.swSettings = {
        preset: this.videoSettings.swSettings?.preset || 'veryfast',
        quality: this.videoSettings.swSettings?.quality || '23',
        profile: this.videoSettings.swSettings?.profile || 'high',
        level: this.videoSettings.swSettings?.level || '4.0',
        tune: this.videoSettings.swSettings?.tune ?? ''
      };

      this.videoSettings.colorRange = this.videoSettings.colorRange || 'auto';
      this.videoSettings.colorPrimaries = this.videoSettings.colorPrimaries || 'auto';
      this.videoSettings.nvencSettings = {
        preset: this.videoSettings.nvencSettings?.preset || 'p4',
        tune: this.videoSettings.nvencSettings?.tune ?? '',
        quality: this.videoSettings.nvencSettings?.quality || '23',
        profile: this.videoSettings.nvencSettings?.profile || 'high',
        level: this.videoSettings.nvencSettings?.level || '4.0'
      };

      this.videoSettings.qsvSettings = {
        preset: this.videoSettings.qsvSettings?.preset || 'veryfast',
        quality: this.videoSettings.qsvSettings?.quality || '26',
        profile: this.videoSettings.qsvSettings?.profile || 'main',
        level: this.videoSettings.qsvSettings?.level || 'auto',
        tune: this.videoSettings.qsvSettings?.tune ?? ''
      };

      this.videoSettings.vaapiSettings = {
        device: this.videoSettings.vaapiSettings?.device || '/dev/dri/renderD128',
        quality: this.videoSettings.vaapiSettings?.quality || '26',
        profile: this.videoSettings.vaapiSettings?.profile || 'main',
        level: this.videoSettings.vaapiSettings?.level || 'auto',
        tune: this.videoSettings.vaapiSettings?.tune ?? ''
      };

      const hw = String(this.videoSettings.hwaccel || 'off').toLowerCase();
      if (hw === 'qsv') this.videoSettings.qsvSettings.level = 'auto';
      if (hw === 'vaapi') this.videoSettings.vaapiSettings.level = 'auto';
    } catch (e) {
      console.warn('[VideoSettingsManager] Failed to load:', e);
    }
  }

  saveToStorage() {
    this.normalizeHdrToneMapping();
    const hw = String(this.videoSettings.hwaccel || 'off').toLowerCase();
    const codec = String(this.videoSettings.videoCodec || 'auto');
    const base = codec.replace(/_10bit$/, '');

    if (hw === 'qsv') this.videoSettings.qsvSettings.level = 'auto';
    if (hw === 'vaapi') this.videoSettings.vaapiSettings.level = 'auto';
    if (hw === 'off' && base === 'h265') {
      const allowed = new Set((this.tuneOptions.h265 || []).map(x => x.value));
      const cur = String(this.videoSettings.swSettings?.tune || '');
      if (cur && !allowed.has(cur)) this.videoSettings.swSettings.tune = '';
    }

    if (hw === 'qsv') this.videoSettings.qsvSettings.tune = '';
    if (hw === 'vaapi') this.videoSettings.vaapiSettings.tune = '';

    localStorage.setItem('videoSettings', JSON.stringify(this.videoSettings));
  }

  createUI() {
    const formatSelect = document.getElementById('formatSelect');
    if (!formatSelect) return;

    const container = document.createElement('div');
    container.id = 'videoSettingsContainer';
    container.className = 'video-settings-container';

    container.innerHTML = `
      <div class="form-group">
        <label class="checkbox-label" style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="videoTranscodeCheckbox" />
          <span data-i18n="label.videoTranscode">${this.t('label.videoTranscode', 'Enable Video Transcoding')}</span>

          <button type="button"
                  id="openVideoSettingsBtn"
                  class="vs-icon-btn"
                  title="${this.t('ui.settings', 'Settings')}"
                  aria-label="${this.t('ui.settings', 'Settings')}">
            ⚙️
          </button>
        </label>

        <div class="muted" style="font-size:12px; margin-top:6px;">
          <span data-i18n="ui.transcode.opensModal">
            ${this.t('ui.transcode.opensModal', 'When enabled, a settings window opens.')}
          </span>
        </div>
      </div>
    `;

    const bitrateGroup = document.querySelector('.form-group:has(#bitrateSelect)');
    if (bitrateGroup && bitrateGroup.parentNode) {
      bitrateGroup.parentNode.insertBefore(container, bitrateGroup.nextSibling);
    } else {
      formatSelect.parentNode.insertBefore(container, formatSelect.nextSibling);
    }

    if (window.i18n?.apply) window.i18n.apply(container);
  }

  attachEvents() {
    const transcodeCheckbox = document.getElementById('videoTranscodeCheckbox');
    if (!transcodeCheckbox) return;

    transcodeCheckbox.checked = !!this.videoSettings.transcodeEnabled;

    transcodeCheckbox.addEventListener('change', (e) => {
      const checked = !!e.target.checked;

      if (checked) {
        this.pendingOpenFromCheckbox = true;
        this.videoSettings.transcodeEnabled = true;
        this.saveToStorage();

        this.openSettingsModal({
          onApply: () => { transcodeCheckbox.checked = true; }
        });
      } else {
        this.videoSettings.transcodeEnabled = false;
        this.videoSettings.audioTranscodeEnabled = false;
        this.saveToStorage();
        if (this.modalOpen) this.closeSettingsModal();
      }
    });

    const openBtn = document.getElementById('openVideoSettingsBtn');
    openBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!this.videoSettings.transcodeEnabled) {
        this.videoSettings.transcodeEnabled = true;
        this.saveToStorage();
        transcodeCheckbox.checked = true;
      }

      this.openSettingsModal();
    });
  }

  ensureModal() {
    if (!this.backdropEl) {
      const bd = document.createElement('div');
      bd.className = 'vs-modal-backdrop';
      bd.id = 'vsModalBackdrop';
      bd.setAttribute('role', 'presentation');
      bd.style.display = 'none';
      document.body.appendChild(bd);
      this.backdropEl = bd;

      bd.addEventListener('click', (e) => {
        if (e.target === bd) this.handleModalCancel();
      });
    }

    if (!this.modalEl) {
      const modal = document.createElement('div');
      modal.className = 'vs-modal';
      modal.id = 'vsModal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.style.display = 'none';

      modal.innerHTML = this.getModalHTML();
      this.backdropEl.appendChild(modal);
      this.modalEl = modal;

      window.addEventListener('keydown', (ev) => {
        if (!this.modalOpen) return;
        if (ev.key === 'Escape') this.handleModalCancel();
      });
    }
  }

  openSettingsModal({ onCancel, onApply } = {}) {
    this.ensureModal();
    this._modalOnCancel = typeof onCancel === 'function' ? onCancel : null;
    this._modalOnApply = typeof onApply === 'function' ? onApply : null;

    this.syncModalUIFromState();
    this.bindModalEventsOnce();

    this.backdropEl.style.display = 'flex';
    this.modalEl.style.display = 'block';
    this.modalOpen = true;

    if (window.i18n?.apply) window.i18n.apply(this.modalEl);

    const first = this.modalEl.querySelector('#hwaccelSelect') || this.modalEl.querySelector('button');
    first?.focus?.();
  }

  closeSettingsModal() {
    if (!this.modalEl || !this.backdropEl) return;
    this.modalEl.style.display = 'none';
    this.backdropEl.style.display = 'none';
    this.modalOpen = false;
    this.pendingOpenFromCheckbox = false;
  }

  handleModalCancel() {
    if (this._modalOnCancel) this._modalOnCancel();
    this.closeSettingsModal();
  }

  handleModalApply() {
    this.syncStateFromModalUI();
    const c = this.videoSettings.videoCodec || 'auto';
    const h = this.videoSettings.hwaccel || 'off';
    if (c !== 'auto' && c !== 'copy') this.updateEncoderSpecificOptions(c, h);
    else this.normalizeTuneForContext(c, h);

    this.saveToStorage();

    if (this._modalOnApply) this._modalOnApply();
    this.closeSettingsModal();
  }

  syncStateFromModalUI() {
    if (!this.modalEl) return;

    const v = (sel) => {
      const el = this.modalEl.querySelector(sel);
      return el ? String(el.value ?? '') : '';
    };
    const b = (sel) => {
      const el = this.modalEl.querySelector(sel);
      return !!(el && el.checked);
    };

    this.videoSettings.hdrMode = v('#hdrModeSelect') || 'auto';
    this.videoSettings.hdrToneMapping = v('#hdrToneMappingSelect') || 'hable';
    this.videoSettings.hdrPeakBrightness = String(v('#hdrPeakBrightness') || '1000');

    this.videoSettings.hwaccel = v('#hwaccelSelect') || 'off';
    this.videoSettings.videoCodec = v('#videoCodecSelect') || 'auto';
    this.videoSettings.fps = v('#fpsSelect') || 'source';
    this.videoSettings.proresProfile = v('#proresProfileSelect') || '2';

    this.videoSettings.swSettings = {
      quality: v('#swQuality') || '23',
      preset: v('#swPresetSelect') || 'veryfast',
      tune: v('#swTuneSelect'),
      profile: v('#swProfileSelect'),
      level: v('#swLevelSelect') || 'auto'
    };

    this.videoSettings.colorRange = v('#colorRangeSelect') || 'auto';
    this.videoSettings.colorPrimaries = v('#colorPrimariesSelect') || 'auto';

    this.videoSettings.nvencSettings = {
      preset: v('#nvencPreset') || 'p4',
      tune: v('#nvencTuneSelect') ?? '',
      quality: v('#nvencQuality') || '23',
      profile: v('#nvencProfileSelect'),
      level: v('#nvencLevelSelect') || 'auto'
    };

    this.videoSettings.qsvSettings = {
      preset: v('#qsvPreset') || 'veryfast',
      tune: '',
      quality: v('#qsvQuality') || '26',
      profile: v('#qsvProfileSelect'),
      level: 'auto'
    };

    this.videoSettings.vaapiSettings = {
      device: v('#vaapiDevice') || '/dev/dri/renderD128',
      tune: '',
      quality: v('#vaapiQuality') || '26',
      profile: v('#vaapiProfileSelect'),
      level: 'auto'
    };

    this.videoSettings.scaleMode = v('#widthModeSelect') || 'auto';
    this.videoSettings.targetWidth = (this.videoSettings.scaleMode === 'custom') ? v('#customWidthInput') : '';
    this.videoSettings.heightMode = v('#heightModeSelect') || 'auto';
    this.videoSettings.targetHeight = (this.videoSettings.heightMode === 'custom') ? v('#customHeightInput') : '';
    this.videoSettings.allowUpscale = (this.videoSettings.heightMode === 'custom') ? b('#allowUpscaleCheckbox') : false;
    this.videoSettings.orientation = v('#orientationSelect') || 'auto';
    this.videoSettings.resizeMode = v('#resizeModeSelect') || 'scale';
    this.videoSettings.cropEnabled = b('#cropEnabledCheckbox');
    this.videoSettings.cropLeft = v('#cropLeftInput') || '0';
    this.videoSettings.cropRight = v('#cropRightInput') || '0';
    this.videoSettings.cropTop = v('#cropTopInput') || '0';
    this.videoSettings.cropBottom = v('#cropBottomInput') || '0';
    this.videoSettings.borderEnabled = b('#borderEnabledCheckbox');
    this.videoSettings.borderSize = v('#borderSizeInput') || '0';
    this.videoSettings.borderColor = v('#borderColorInput') || '#000000';
    this.videoSettings.audioTranscodeEnabled = b('#audioTranscodeCheckbox');
    this.videoSettings.audioCodec = v('#audioCodecSelect') || 'aac';
    this.videoSettings.audioChannels = v('#audioChannelsSelect') || 'original';
    this.videoSettings.audioSampleRate = v('#audioSampleRateSelect') || '48000';

    const abrEl = this.modalEl.querySelector('#audioBitrateSelect');
    if (abrEl) this.videoSettings.audioBitrate = String(abrEl.value ?? '');
  }

  hwKey(hardware) {
    const h = String(hardware || '').toLowerCase();
    return (h === 'off' || h === 'software') ? 'sw' : h;
  }

  shouldEnableTune(baseCodec, hardware) {
    const hw = String(hardware || 'off').toLowerCase();
    if (hw === 'nvenc') return true;
    if (hw === 'qsv' || hw === 'vaapi') return false;
    return (baseCodec === 'h264' || baseCodec === 'h265');
  }

  normalizeTuneForContext(codecValue, hardware) {
    const hw = this.hwKey(hardware);
    const baseCodec = String(codecValue || '').replace(/_10bit$/, '');

    const key =
      hw === 'nvenc' ? 'nvencSettings'
      : hw === 'qsv' ? 'qsvSettings'
      : hw === 'vaapi' ? 'vaapiSettings'
      : 'swSettings';

    const sel = this.modalEl?.querySelector(`#${hw}TuneSelect`);
    const enabled = this.shouldEnableTune(baseCodec, hardware);

    if (!enabled) {
      if (this.videoSettings?.[key]) this.videoSettings[key].tune = '';
      if (sel) { sel.value = ''; sel.disabled = true; }
      this.saveToStorage();
      return;
    }

    if (sel) sel.disabled = false;

    const opts =
      (String(hardware || '').toLowerCase() === 'nvenc')
        ? (this.tuneOptions.nvenc || [])
        : (this.tuneOptions[baseCodec] || []);

    const allowed = new Set(opts.map(o => o.value));
    const cur = String(this.videoSettings?.[key]?.tune || '');

    if (cur && !allowed.has(cur)) {
      this.videoSettings[key].tune = '';
      if (sel) sel.value = '';
      this.saveToStorage();
    }
  }

  updateEncoderSpecificOptions(codecValue, hardware) {
    const baseCodec = String(codecValue || 'auto').replace(/_10bit$/, '');
    const hw = String(hardware || 'off').toLowerCase();

    const pickProfilesFor = (baseCodec, codecValue, hw) => {
    const is10 = /_10bit$/.test(codecValue);

    if (baseCodec === 'h264' && is10 && String(hw).toLowerCase() === 'off') {
        return this.profileOptions.h264_10bit || this.profileOptions.default;
      }

      if (baseCodec === 'h265') {
        if (is10) {
          return [
            { value: 'main10', labelKey: 'option.profile.main10', fallback: 'Main 10 (10-bit, 4:2:0)' },
            { value: 'main', labelKey: 'option.profile.main', fallback: 'Main (8-bit, 4:2:0)' }
          ];
        }
        return [
                    { value: 'main', labelKey: 'option.profile.main', fallback: 'Main (8-bit, 4:2:0)' },
          { value: 'main10', labelKey: 'option.profile.main10', fallback: 'Main 10 (10-bit, 4:2:0)' }
        ];
      }

      if (baseCodec === 'h264') return this.profileOptions.h264 || this.profileOptions.default;
      if (baseCodec === 'av1') return this.profileOptions.av1 || this.profileOptions.default;
      if (baseCodec === 'vp9') return this.profileOptions.vp9 || this.profileOptions.default;

      return this.profileOptions.default;
    };

    const tuneOptions =
      hw === 'nvenc' ? (this.tuneOptions.nvenc || [])
      : (this.tuneOptions[baseCodec] || this.tuneOptions.default || []);

    const profileOptions = pickProfilesFor.call(this, baseCodec, codecValue, hw);

    this.updateTuneOptions(tuneOptions, hardware, baseCodec);
    this.updateProfileOptions(profileOptions, hardware);
    this.updateLevelOptions(hardware, codecValue);

    this.normalizeProfileForCurrentContext(codecValue, hardware, profileOptions);
    this.normalizeTuneForContext(codecValue, hardware);
  }

  updateTuneOptions(tuneOptions, hardware, baseCodec = '') {
    const hw = this.hwKey(hardware);
    const tuneSelectId = `${hw}TuneSelect`;
    const tuneSelect = this.modalEl?.querySelector(`#${tuneSelectId}`);
    if (!tuneSelect) return;

    const enabled = this.shouldEnableTune(baseCodec, hardware);
    const currentValue = String(tuneSelect.value || '');

    tuneSelect.innerHTML = '';

    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = this.t('option.tune.none', 'None');
    tuneSelect.appendChild(emptyOption);

    (tuneOptions || []).forEach(tune => {
      const option = document.createElement('option');
      option.value = tune.value;
      option.textContent = this.t(tune.labelKey, tune.fallback);
      tuneSelect.appendChild(option);
    });

    tuneSelect.disabled = !enabled;
    if (enabled && currentValue && (tuneOptions || []).some(t => t.value === currentValue)) {
      tuneSelect.value = currentValue;
    } else {
      tuneSelect.value = '';
    }
  }

  updateProfileOptions(profileOptions, hardware) {
    const hw = this.hwKey(hardware);
    const profileSelectId = `${hw}ProfileSelect`;
    const profileSelect = this.modalEl?.querySelector(`#${profileSelectId}`);
    if (!profileSelect) return;

    const currentValue = String(profileSelect.value || '');
    profileSelect.innerHTML = '';

    (profileOptions || []).forEach(profile => {
      const option = document.createElement('option');
      option.value = profile.value;
      option.textContent = this.t(profile.labelKey, profile.fallback);
      profileSelect.appendChild(option);
    });

    if (currentValue && (profileOptions || []).some(p => p.value === currentValue)) {
      profileSelect.value = currentValue;
    } else if ((profileOptions || []).length) {
      profileSelect.value = profileOptions[0].value;
    }
  }

  updateLevelOptions(hardware, codecValue) {
    const hw = this.hwKey(hardware);
    const levelSelectId = `${hw}LevelSelect`;
    const levelSelect = this.modalEl?.querySelector(`#${levelSelectId}`);
    if (!levelSelect) return;

    const currentValue = String(levelSelect.value || '');
    levelSelect.innerHTML = '';

    const forceAuto = (String(hardware || '').toLowerCase() === 'qsv' || String(hardware || '').toLowerCase() === 'vaapi');

    if (forceAuto) {
      const option = document.createElement('option');
      option.value = 'auto';
      option.textContent = this.t('option.level.auto', 'Auto (FFmpeg default)');
      option.selected = true;
      levelSelect.appendChild(option);
      levelSelect.disabled = true;

      const key = (String(hardware).toLowerCase() === 'qsv') ? 'qsvSettings' : 'vaapiSettings';
      if (this.videoSettings?.[key] && this.videoSettings[key].level !== 'auto') {
        this.videoSettings[key].level = 'auto';
        this.saveToStorage();
      }
      return;
    }

    this.levelOptions.forEach(level => {
      const option = document.createElement('option');
      option.value = level.value;
      option.textContent = this.t(level.labelKey, level.fallback);
      levelSelect.appendChild(option);
    });

    levelSelect.disabled = false;

    if (currentValue && this.levelOptions.some(l => l.value === currentValue)) {
      levelSelect.value = currentValue;
    } else {
      levelSelect.value = 'auto';
    }
  }

  normalizeProfileForCurrentContext(codecValue, hardware, profileOptions) {
    const hw = this.hwKey(hardware);
    const baseCodec = String(codecValue || 'auto').replace(/_10bit$/, '');

    const key =
      hw === 'nvenc' ? 'nvencSettings'
      : hw === 'qsv' ? 'qsvSettings'
      : hw === 'vaapi' ? 'vaapiSettings'
      : 'swSettings';

    const current = String(this.videoSettings?.[key]?.profile || '').trim();
    const allowed = new Set((profileOptions || []).map(p => String(p.value)));

    if (!allowed.size) return;
    if (!current || !allowed.has(current)) {
      let fallback = (profileOptions?.[0]?.value) || '';

      if (baseCodec === 'h265') {
        if (/_10bit$/.test(codecValue) && allowed.has('main10')) fallback = 'main10';
        else if (allowed.has('main')) fallback = 'main';
      }

      if (this.videoSettings?.[key]) {
        this.videoSettings[key].profile = fallback;
        this.saveToStorage();
      }

      const sel = this.modalEl?.querySelector(`#${hw}ProfileSelect`);
      if (sel) sel.value = fallback;
    }
  }

  getModalHTML() {
    return `
      <div class="vs-modal-shell">
        <div class="vs-modal-header">
          <div class="vs-title">
            <span class="vs-title-main" data-i18n="ui.transcode.title">${this.t('ui.transcode.title', 'Transcoding Settings')}</span>
            <span class="vs-title-sub" data-i18n="ui.transcode.subtitle">${this.t('ui.transcode.subtitle', 'Video + Audio')}</span>
          </div>

          <button type="button" class="vs-icon-btn" id="vsModalClose" aria-label="Close">✕</button>
        </div>

        <div class="vs-modal-body">
          <div class="vs-section">
            <div class="vs-section-title" data-i18n="ui.transcode.videoSection">${this.t('ui.transcode.videoSection', 'Video')}</div>

            <div class="vs-grid">
              <div class="form-group">
                <label for="hwaccelSelect" data-i18n="label.hwaccel">${this.t('label.hwaccel', 'HWAccel')}</label>
                <select id="hwaccelSelect">
                  <option value="off" data-i18n="option.software">${this.t('option.software', 'Software')}</option>
                  <option value="nvenc" data-i18n="option.nvenc">${this.t('option.nvenc', 'NVENC')}</option>
                  <option value="qsv" data-i18n="option.qsv">${this.t('option.qsv', 'QSV')}</option>
                  <option value="vaapi" data-i18n="option.vaapi">${this.t('option.vaapi', 'VAAPI')}</option>
                </select>
              </div>

              <div class="form-group">
                <label for="colorRangeSelect"
                      data-i18n="label.colorRange">
                  ${this.t('label.colorRange', 'Color Range')}
                </label>
                <select id="colorRangeSelect">
                  <option value="auto"
                          data-i18n="option.auto">
                    ${this.t('option.auto', 'Auto')}
                  </option>
                  <option value="tv"
                          data-i18n="option.colorRangeLimited">
                    ${this.t('option.colorRangeLimited', 'Limited (TV)')}
                  </option>
                  <option value="pc"
                          data-i18n="option.colorRangeFull">
                    ${this.t('option.colorRangeFull', 'Full (PC)')}
                  </option>
                </select>
              </div>

              <div class="form-group">
                <label for="colorPrimariesSelect"
                      data-i18n="label.colorPrimaries">
                  ${this.t('label.colorPrimaries', 'Color Primaries')}
                </label>
                <select id="colorPrimariesSelect">
                  <option value="auto"
                          data-i18n="option.auto">
                    ${this.t('option.auto', 'Auto')}
                  </option>
                  <option value="bt709">BT.709</option>
                  <option value="bt2020">BT.2020</option>
                  <option value="smpte170m">SMPTE 170M</option>
                  <option value="bt470bg">BT.470 BG</option>
                  <option value="smpte240m">SMPTE 240M</option>
                </select>
              </div>

              <div class="form-group">
             <label for="hdrModeSelect" data-i18n="label.hdrMode">${this.t('label.hdrMode', 'HDR Mode')}</label>
             <select id="hdrModeSelect">
               <option value="auto" data-i18n="option.hdrMode.auto">${this.t('option.hdrMode.auto', 'Auto (Detect & Process)')}</option>
               <option value="tonemap_to_sdr" data-i18n="option.hdrMode.tonemap">${this.t('option.hdrMode.tonemap', 'Tonemap HDR to SDR')}</option>
               <option value="keep_hdr" data-i18n="option.hdrMode.keep">${this.t('option.hdrMode.keep', 'Keep HDR (Passthrough)')}</option>
             </select>
             <div class="muted vs-help">
               <span data-i18n="option.hdrMode.note">${this.t('option.hdrMode.note', 'Auto: HDR varsa tonemap, yoksa normal. Keep HDR: 10-bit codec gerekir.')}</span>
             </div>
           </div>

           <div class="form-group" id="hdrToneMappingGroup" style="display:none;">
             <label for="hdrToneMappingSelect" data-i18n="label.hdrToneMapping">${this.t('label.hdrToneMapping', 'Tone Mapping')}</label>
             <select id="hdrToneMappingSelect">
               <option value="hable" data-i18n="option.toneMapping.hable">${this.t('option.toneMapping.hable', 'Hable (Filmic, Default)')}</option>
               <option value="mobius" data-i18n="option.toneMapping.mobius">${this.t('option.toneMapping.mobius', 'Mobius (Soft)')}</option>
               <option value="reinhard" data-i18n="option.toneMapping.reinhard">${this.t('option.toneMapping.reinhard', 'Reinhard (Natural)')}</option>
             </select>
           </div>

           <div class="form-group" id="hdrPeakBrightnessGroup" style="display:none;">
             <label for="hdrPeakBrightness" data-i18n="label.hdrPeakBrightness">${this.t('label.hdrPeakBrightness', 'Peak Brightness (nits)')}</label>
             <input type="range" id="hdrPeakBrightness" min="100" max="4000" step="100" />
             <div class="vs-range-row">
               <span id="hdrPeakBrightnessValue" class="range-value">1000</span>
               <div class="range-hints">
                 <span>100 (<span data-i18n="ui.dark">${this.t('ui.dark', 'Dark')}</span>)</span>
                 <span>1000 (<span data-i18n="ui.default">${this.t('ui.default', 'Default')}</span>)</span>
                 <span>4000 (<span data-i18n="ui.bright">${this.t('ui.bright', 'Bright')}</span>)</span>
               </div>
             </div>
           </div>

              <div class="form-group">
                <label for="videoCodecSelect" data-i18n="label.videoCodec">${this.t('label.videoCodec', 'Video Codec')}</label>
                <select id="videoCodecSelect"></select>
                <div class="muted vs-help">
                  <span id="codecDescription"></span>
                  <span id="hwSupportInfo" class="hw-support-info"></span>
                </div>
              </div>

              <div class="form-group">
                <label for="fpsSelect" data-i18n="label.fps">${this.t('label.fps', 'FPS')}</label>
                <select id="fpsSelect">
                  <option value="source" data-i18n="option.videoNone">${this.t('option.videoNone', 'Source')}</option>
                  <option value="23.976" data-i18n="option.23976">${this.t('option.23976', '23.976')}</option>
                  <option value="24" data-i18n="option.24">${this.t('option.24', '24')}</option>
                  <option value="25" data-i18n="option.25">${this.t('option.25', '25')}</option>
                  <option value="30" data-i18n="option.30">${this.t('option.30', '30')}</option>
                  <option value="50" data-i18n="option.50">${this.t('option.50', '50')}</option>
                  <option value="60" data-i18n="option.60">${this.t('option.60', '60')}</option>
                </select>
                <div class="muted vs-help">
                  <span data-i18n="option.note">${this.t('option.note', 'Keep source FPS or choose a fixed FPS.')}</span>
                </div>
              </div>

              <div class="form-group">
                <label for="orientationSelect" data-i18n="label.orientation">${this.t('label.orientation', 'Orientation')}</label>
                <select id="orientationSelect">
                  <option value="auto">${this.t('option.auto', 'Auto')}</option>
                  <option value="none">${this.t('option.orientation.none', 'Disable autorotate')}</option>
                  <option value="90cw">${this.t('option.orientation.90cw', 'Rotate 90° CW')}</option>
                  <option value="90ccw">${this.t('option.orientation.90ccw', 'Rotate 90° CCW')}</option>
                  <option value="180">${this.t('option.orientation.180', 'Rotate 180°')}</option>
                  <option value="hflip">${this.t('option.orientation.hflip', 'Flip Horizontal')}</option>
                  <option value="vflip">${this.t('option.orientation.vflip', 'Flip Vertical')}</option>
                </select>
                <div class="muted vs-help">
                  <span data-i18n="option.orientation.note">${this.t('option.orientation.note', 'Auto uses source metadata. "Disable autorotate" ignores rotation tags.')}</span>
                </div>
              </div>

              <div class="form-group">
                <label for="resizeModeSelect" data-i18n="label.resizeMode">${this.t('label.resizeMode', 'Resize Mode')}</label>
                <select id="resizeModeSelect">
                  <option value="scale">${this.t('option.resize.scale', 'Scale (default)')}</option>
                  <option value="crop">${this.t('option.resize.crop', 'Crop to Fill')}</option>
                  <option value="pad">${this.t('option.resize.pad', 'Pad / Letterbox')}</option>
                </select>
                <div class="muted vs-help">
                  <span data-i18n="option.resize.note">${this.t('option.resize.note', 'Crop/Pad works best when both Width and Height are set.')}</span>
                </div>
              </div>
            </div>

            <div class="vs-encoder-box">
              <div id="offSettings" class="encoder-specific-settings">
                <div class="vs-grid">
                  <div class="form-group">
                    <label for="swQuality" data-i18n="label.swQuality">${this.t('label.swQuality', 'Software Quality (CRF)')}</label>
                    <input type="range" id="swQuality" min="16" max="30" step="1" />
                    <div class="vs-range-row">
                      <span id="swQualityValue" class="range-value"></span>
                      <div class="range-hints">
                        <span>16 (<span data-i18n="ui.bestQuality">${this.t('ui.bestQuality', 'Best')}</span>)</span>
                        <span>23 (<span data-i18n="ui.default">${this.t('ui.default', 'Default')}</span>)</span>
                        <span>30 (<span data-i18n="ui.fastest">${this.t('ui.fastest', 'Fastest')}</span>)</span>
                      </div>
                    </div>
                  </div>

                  <div class="form-group">
                    <label for="swPresetSelect">${this.t('label.preset', 'Preset')}</label>
                    <select id="swPresetSelect">
                      <option value="ultrafast">ultrafast</option>
                      <option value="superfast">superfast</option>
                      <option value="veryfast">veryfast</option>
                      <option value="faster">faster</option>
                      <option value="fast">fast</option>
                      <option value="medium">medium</option>
                      <option value="slow">slow</option>
                      <option value="slower">slower</option>
                      <option value="veryslow">veryslow</option>
                    </select>
                  </div>

                  <div class="form-group">
                    <label for="swTuneSelect" data-i18n="label.tune">${this.t('label.tune', 'Tune')}</label>
                    <select id="swTuneSelect"></select>
                  </div>

                  <div class="form-group">
                    <label for="swProfileSelect" data-i18n="label.profile">${this.t('label.profile', 'Profile')}</label>
                    <select id="swProfileSelect"></select>
                  </div>

                  <div class="form-group">
                  <label for="swLevelSelect" data-i18n="label.level">${this.t('label.level', 'Level')}</label>
                  <select id="swLevelSelect"></select>
                  <div class="muted vs-help">
                    <span data-i18n="option.level.note">${this.t('option.level.note', 'Restricts bitrate/resolution for compatibility. "Auto" lets FFmpeg decide.')}</span>
                  </div>
                </div>
                  <div class="form-group" id="proresProfileGroup" style="display:none;">
                    <label for="proresProfileSelect" data-i18n="label.proresProfile">
                      ${this.t('label.proresProfile', 'ProRes Profile')}
                    </label>
                    <select id="proresProfileSelect">
                      <option value="0">0 — ProRes 422 Proxy</option>
                      <option value="1">1 — ProRes 422 LT</option>
                      <option value="2">2 — ProRes 422 Standard</option>
                      <option value="3">3 — ProRes 422 HQ</option>
                      <option value="4">4 — ProRes 4444</option>
                      <option value="5">5 — ProRes 4444 XQ</option>
                    </select>
                    <div class="muted vs-help">
                      <span data-i18n="ui.prores.note">
                        ${this.t('ui.prores.note', 'Higher profiles increase bitrate/quality. 4444 is 4:4:4.' )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div id="nvencSettings" class="encoder-specific-settings" style="display:none;">
                <div class="vs-grid">
                  <div class="form-group">
                    <label for="nvencPreset" data-i18n="label.nvencPreset">${this.t('label.nvencPreset', 'NVENC Preset')}</label>
                    <select id="nvencPreset">
                      <option value="p1" data-i18n="option.nvencP1">${this.t('option.nvencP1', 'P1 – Fastest')}</option>
                      <option value="p2" data-i18n="option.nvencP2">${this.t('option.nvencP2', 'P2 – Very Fast')}</option>
                      <option value="p3" data-i18n="option.nvencP3">${this.t('option.nvencP3', 'P3 – Fast')}</option>
                      <option value="p4" data-i18n="option.nvencP4">${this.t('option.nvencP4', 'P4 – Balanced')}</option>
                      <option value="p5" data-i18n="option.nvencP5">${this.t('option.nvencP5', 'P5 – Quality')}</option>
                      <option value="p6" data-i18n="option.nvencP6">${this.t('option.nvencP6', 'P6 – Higher Quality')}</option>
                      <option value="p7" data-i18n="option.nvencP7">${this.t('option.nvencP7', 'P7 – Best Quality')}</option>
                    </select>
                  </div>

                  <div class="form-group">
                    <label for="nvencTuneSelect" data-i18n="label.nvencTune">${this.t('label.nvencTune', 'NVENC Tune')}</label>
                    <select id="nvencTuneSelect">
                      <option value="" data-i18n="option.nvencTuneOff">${this.t('option.nvencTuneOff', 'Off')}</option>
                      <option value="hq" data-i18n="option.nvencTuneHQ">${this.t('option.nvencTuneHQ', 'HQ')}</option>
                      <option value="ll" data-i18n="option.nvencTuneLL">${this.t('option.nvencTuneLL', 'LL')}</option>
                      <option value="ull" data-i18n="option.nvencTuneULL">${this.t('option.nvencTuneULL', 'ULL')}</option>
                      <option value="lossless" data-i18n="option.nvencTuneLossless">${this.t('option.nvencTuneLossless', 'Lossless')}</option>
                    </select>
                  </div>

                  <div class="form-group">
                    <label for="nvencQuality" data-i18n="label.nvencQuality">${this.t('label.nvencQuality', 'NVENC Quality (CQ)')}</label>
                    <input type="range" id="nvencQuality" min="18" max="30" step="1" />
                    <div class="vs-range-row">
                      <span id="nvencQualityValue" class="range-value">23</span>
                      <div class="range-hints">
                        <span>18 (<span data-i18n="ui.bestQuality">${this.t('ui.bestQuality', 'Best')}</span>)</span>
                        <span>23 (<span data-i18n="ui.default">${this.t('ui.default', 'Default')}</span>)</span>
                        <span>30 (<span data-i18n="ui.fastest">${this.t('ui.fastest', 'Fastest')}</span>)</span>
                      </div>
                    </div>
                  </div>

                  <div class="form-group">
                    <label for="nvencProfileSelect" data-i18n="label.profile">${this.t('label.profile', 'Profile')}</label>
                    <select id="nvencProfileSelect"></select>
                  </div>

                  <div class="form-group">
                    <label for="nvencLevelSelect" data-i18n="label.level">${this.t('label.level', 'Level')}</label>
                    <select id="nvencLevelSelect"></select>
                    <div class="muted vs-help">
                      <span data-i18n="option.level.note">${this.t('option.level.note', 'Restricts bitrate/resolution for compatibility. "Auto" lets FFmpeg decide.')}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div id="qsvSettings" class="encoder-specific-settings" style="display:none;">
                <div class="vs-grid">
                  <div class="form-group">
                    <label for="qsvPreset" data-i18n="label.qsvPreset">${this.t('label.qsvPreset', 'QSV Preset')}</label>
                    <select id="qsvPreset">
                      <option value="veryfast" data-i18n="option.qsvVeryfast">${this.t('option.qsvVeryfast', 'Veryfast')}</option>
                      <option value="faster" data-i18n="option.qsvFaster">${this.t('option.qsvFaster', 'Faster')}</option>
                      <option value="fast" data-i18n="option.qsvFast">${this.t('option.qsvFast', 'Fast')}</option>
                      <option value="medium" data-i18n="option.qsvMedium">${this.t('option.qsvMedium', 'Medium')}</option>
                      <option value="slow" data-i18n="option.qsvSlow">${this.t('option.qsvSlow', 'Slow')}</option>
                      <option value="slower" data-i18n="option.qsvSlower">${this.t('option.qsvSlower', 'Slower')}</option>
                      <option value="veryslow" data-i18n="option.qsvVeryslow">${this.t('option.qsvVeryslow', 'Veryslow')}</option>
                    </select>
                  </div>

                  <div class="form-group">
                    <label for="qsvTuneSelect" data-i18n="label.tune">${this.t('label.tune', 'Tune')}</label>
                    <select id="qsvTuneSelect"></select>
                  </div>

                  <div class="form-group">
                    <label for="qsvQuality" data-i18n="label.qsvQuality">${this.t('label.qsvQuality', 'QSV Quality')}</label>
                    <input type="range" id="qsvQuality" min="18" max="30" step="1" />
                    <div class="vs-range-row">
                      <span id="qsvQualityValue" class="range-value">23</span>
                      <div class="range-hints">
                        <span>18 (<span data-i18n="ui.bestQuality">${this.t('ui.bestQuality', 'Best')}</span>)</span>
                        <span>23 (<span data-i18n="ui.default">${this.t('ui.default', 'Default')}</span>)</span>
                        <span>30 (<span data-i18n="ui.fastest">${this.t('ui.fastest', 'Fastest')}</span>)</span>
                      </div>
                    </div>
                  </div>

                  <div class="form-group">
                    <label for="qsvProfileSelect" data-i18n="label.profile">${this.t('label.profile', 'Profile')}</label>
                    <select id="qsvProfileSelect"></select>
                  </div>

                  <div class="form-group">
                    <label for="qsvLevelSelect" data-i18n="label.level">${this.t('label.level', 'Level')}</label>
                    <select id="qsvLevelSelect"></select>
                    <div class="muted vs-help">
                      <span data-i18n="option.level.qsv.note">${this.t('option.level.qsv.note', 'QSV encoder automatically selects appropriate level.')}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div id="vaapiSettings" class="encoder-specific-settings" style="display:none;">
                <div class="vs-grid">
                  <div class="form-group">
                    <label for="vaapiDevice" data-i18n="label.vaapiDevice">${this.t('label.vaapiDevice', 'VAAPI Device')}</label>
                    <input type="text" id="vaapiDevice" placeholder="/dev/dri/renderD128" />
                  </div>

                  <div class="form-group">
                    <label for="vaapiTuneSelect" data-i18n="label.tune">${this.t('label.tune', 'Tune')}</label>
                    <select id="vaapiTuneSelect"></select>
                  </div>

                  <div class="form-group">
                    <label for="vaapiQuality" data-i18n="label.vaapiQuality">${this.t('label.vaapiQuality', 'VAAPI Quality')}</label>
                    <input type="range" id="vaapiQuality" min="18" max="30" step="1" />
                    <div class="vs-range-row">
                      <span id="vaapiQualityValue" class="range-value">23</span>
                      <div class="range-hints">
                        <span>18 (<span data-i18n="ui.bestQuality">${this.t('ui.bestQuality', 'Best')}</span>)</span>
                        <span>23 (<span data-i18n="ui.default">${this.t('ui.default', 'Default')}</span>)</span>
                        <span>30 (<span data-i18n="ui.fastest">${this.t('ui.fastest', 'Fastest')}</span>)</span>
                      </div>
                    </div>
                  </div>

                  <div class="form-group">
                    <label for="vaapiProfileSelect" data-i18n="label.profile">${this.t('label.profile', 'Profile')}</label>
                    <select id="vaapiProfileSelect"></select>
                  </div>

                  <div class="form-group">
                    <label for="vaapiLevelSelect" data-i18n="label.level">${this.t('label.level', 'Level')}</label>
                    <select id="vaapiLevelSelect"></select>
                    <div class="muted vs-help">
                      <span data-i18n="option.level.vaapi.note">${this.t('option.level.vaapi.note', 'VAAPI encoder automatically selects appropriate level.')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="vs-divider"></div>
            <div class="vs-grid">
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="cropEnabledCheckbox" />
                  <span data-i18n="label.cropEnabled">${this.t('label.cropEnabled', 'Enable Cropping')}</span>
                </label>
                <div id="cropSettingsBox" style="display:none; margin-top:8px;">
                  <div class="vs-grid">
                    <div class="form-group">
                      <label for="cropLeftInput">${this.t('label.cropLeft', 'Crop Left (px)')}</label>
                      <input id="cropLeftInput" type="number" min="0" step="1" placeholder="0" class="vs-compact" />
                    </div>
                    <div class="form-group">
                      <label for="cropRightInput">${this.t('label.cropRight', 'Crop Right (px)')}</label>
                      <input id="cropRightInput" type="number" min="0" step="1" placeholder="0" class="vs-compact" />
                    </div>
                    <div class="form-group">
                      <label for="cropTopInput">${this.t('label.cropTop', 'Crop Top (px)')}</label>
                      <input id="cropTopInput" type="number" min="0" step="1" placeholder="0" class="vs-compact" />
                    </div>
                    <div class="form-group">
                      <label for="cropBottomInput">${this.t('label.cropBottom', 'Crop Bottom (px)')}</label>
                      <input id="cropBottomInput" type="number" min="0" step="1" placeholder="0" class="vs-compact" />
                    </div>
                  </div>
                  <div class="muted vs-help">
                    <span data-i18n="option.crop.note">${this.t('option.crop.note', 'Cropping happens before scaling/padding.')}</span>
                  </div>
                </div>
              </div>

              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="borderEnabledCheckbox" />
                  <span data-i18n="label.borderEnabled">${this.t('label.borderEnabled', 'Add Borders')}</span>
                </label>
                <div id="borderSettingsBox" style="display:none; margin-top:8px;">
                  <div class="vs-inline">
                    <input id="borderSizeInput" type="number" min="0" step="1" placeholder="0" class="vs-compact" />
                    <input id="borderColorInput" type="text" placeholder="#000000" class="vs-compact" />
                  </div>
                  <div class="muted vs-help">
                    <span data-i18n="option.border.note">${this.t('option.border.note', 'Border size in pixels. Color as hex (#RRGGBB).')}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="vs-divider"></div>

            <div class="vs-grid">
              <div class="form-group">
                <label for="widthModeSelect" data-i18n="label.videoWidth">${this.t('label.videoWidth', 'Width')}</label>
                <div class="vs-inline">
                  <select id="widthModeSelect" class="vs-compact">
                    <option value="auto" data-i18n="option.videoWidthAuto">${this.t('option.videoWidthAuto', 'Keep aspect ratio')}</option>
                    <option value="custom" data-i18n="option.videoWHManuel">${this.t('option.videoWHManuel', 'Enter manually')}</option>
                  </select>
                  <input id="customWidthInput" type="number" min="2" step="2" data-i18n-ph="ph.videoWidth" placeholder="${this.t('ph.videoWidth', 'e.g. 1920')}" class="vs-compact" />
                </div>
                <div class="muted vs-help">
                  <span data-i18n="option.widthNote">${this.t('option.widthNote', 'If you set Width, output becomes width:height. If aspect ratio is selected, height is auto-calculated from width.')}</span>
                </div>
              </div>

              <div class="form-group">
                <label for="heightModeSelect" data-i18n="label.videoHeight">${this.t('label.videoHeight', 'Height')}</label>
                <div class="vs-inline">
                  <select id="heightModeSelect" class="vs-compact">
                    <option value="auto" data-i18n="option.videoHeightAuto">${this.t('option.videoHeightAuto', 'Auto')}</option>
                    <option value="source" data-i18n="option.videoHeightSource">${this.t('option.videoHeightSource', 'Keep original')}</option>
                    <option value="custom" data-i18n="option.videoWHManuel">${this.t('option.videoWHManuel', 'Enter manually')}</option>
                  </select>

                  <input id="customHeightInput" type="number" min="2" step="2" data-i18n-ph="ph.videoHeight" placeholder="${this.t('ph.videoHeight', 'e.g. 1080')}" class="vs-compact" />

                  <label class="checkbox-label vs-inline-check">
                    <input type="checkbox" id="allowUpscaleCheckbox" />
                    <span data-i18n="option.allowUpscale">${this.t('option.allowUpscale', 'Upscale')}</span>
                  </label>
                </div>

                <div class="muted vs-help">
                  <span data-i18n="option.heightNote">${this.t('option.heightNote', '')}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="vs-section">
            <div class="vs-section-title" data-i18n="ui.transcode.audioSection">${this.t('ui.transcode.audioSection', 'Audio')}</div>

            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" id="audioTranscodeCheckbox" />
                <span data-i18n="label.audioTranscode">${this.t('label.audioTranscode', 'Change Audio Codec')}</span>
              </label>
            </div>

            <div id="audioCodecSettings" class="vs-audio-box" style="display:none;">
              <div class="vs-grid">
                <div class="form-group">
                  <label for="audioCodecSelect" data-i18n="label.audioCodec">${this.t('label.audioCodec', 'Audio Codec')}</label>
                  <select id="audioCodecSelect">
                    <option value="aac" data-i18n="option.audioAAC">${this.t('option.audioAAC', 'AAC')}</option>
                    <option value="ac3" data-i18n="option.audioAC3">${this.t('option.audioAC3', 'AC3')}</option>
                    <option value="eac3" data-i18n="option.audioEAC3">${this.t('option.audioEAC3', 'EAC3')}</option>
                    <option value="mp3" data-i18n="option.audioMP3">${this.t('option.audioMP3', 'MP3')}</option>
                    <option value="flac" data-i18n="option.audioFLAC">${this.t('option.audioFLAC', 'FLAC')}</option>
                    <option value="copy" data-i18n="option.audioCopy">${this.t('option.audioCopy', 'Copy')}</option>
                  </select>
                </div>

                <div class="form-group">
                  <label for="audioChannelsSelect" data-i18n="label.audioChannels">${this.t('label.audioChannels', 'Channels')}</label>
                  <select id="audioChannelsSelect">
                    <option value="original" data-i18n="option.audioChannelsOriginal">${this.t('option.audioChannelsOriginal', 'Original')}</option>
                    <option value="stereo" data-i18n="option.audioChannelsStereo">${this.t('option.audioChannelsStereo', 'Stereo')}</option>
                    <option value="mono" data-i18n="option.audioChannelsMono">${this.t('option.audioChannelsMono', 'Mono')}</option>
                  </select>
                </div>

                <div class="form-group">
                  <label for="audioSampleRateSelect" data-i18n="label.audioSampleRate">${this.t('label.audioSampleRate', 'Sample Rate')}</label>
                  <select id="audioSampleRateSelect">
                    <option value="original" data-i18n="option.audioSampleRateOriginal">${this.t('option.audioSampleRateOriginal', 'Orijinal')}</option>
                    <option value="48000" data-i18n="option.audioSampleRate48">${this.t('option.audioSampleRate48', '48 kHz')}</option>
                    <option value="44100" data-i18n="option.audioSampleRate44">${this.t('option.audioSampleRate44', '44.1 kHz')}</option>
                    <option value="32000" data-i18n="option.audioSampleRate32">${this.t('option.audioSampleRate32', '32 kHz')}</option>
                    <option value="24000" data-i18n="option.audioSampleRate24">${this.t('option.audioSampleRate24', '24 kHz')}</option>
                    <option value="22050" data-i18n="option.audioSampleRate22">${this.t('option.audioSampleRate22', '22.05 kHz')}</option>
                  </select>
                </div>
              </div>

              <div id="audioBitrateContainer" class="form-group" style="display:none;"></div>
            </div>
          </div>
        </div>

        <div class="vs-modal-footer">
          <button type="button" class="vs-btn vs-btn-ghost" id="vsCancelBtn" data-i18n="ui.cancel">${this.t('ui.cancel', 'Cancel')}</button>
          <button type="button" class="vs-btn vs-btn-primary" id="vsApplyBtn" data-i18n="ui.apply">${this.t('ui.apply', 'Apply')}</button>
        </div>
      </div>
    `;
  }

  toggleAudioCodecSettings(show) {
    const box = this.modalEl?.querySelector('#audioCodecSettings');
    if (box) box.style.display = show ? 'block' : 'none';
  }

  normalizeAudioSampleRateUI() {
    if (!this.modalEl) return;
    const srSel = this.modalEl.querySelector('#audioSampleRateSelect');
    const codecSel = this.modalEl.querySelector('#audioCodecSelect');
    if (!srSel || !codecSel) return;

    const codec = String(codecSel.value || '').toLowerCase();
    const isDolbyLike = (codec === 'ac3' || codec === 'eac3');
    const isAac = (codec === 'aac');
    const restrict = isDolbyLike || isAac;
    const banned = new Set(['24000', '22050']);

    Array.from(srSel.options).forEach(opt => {
      const v = String(opt.value);
      if (banned.has(v)) {
        opt.disabled = restrict;
        opt.hidden = restrict;
      }
    });

    const cur = String(srSel.value || '');
    if (restrict && banned.has(cur)) {
      const fallback = '48000';
      srSel.value = fallback;
      this.videoSettings.audioSampleRate = fallback;
      this.saveToStorage();
    }
  }

  showEncoderSpecificSettings(encoder) {
    if (!this.modalEl) return;

    this.modalEl.querySelectorAll('.encoder-specific-settings').forEach(el => {
      el.style.display = 'none';
    });

    const specific = this.modalEl.querySelector(`#${encoder}Settings`);
    if (specific) specific.style.display = 'block';
    else {
      const off = this.modalEl.querySelector('#offSettings');
      if (off) off.style.display = 'block';
    }
  }

  updateAudioBitrateOptions(codec) {
    const container = this.modalEl?.querySelector('#audioBitrateContainer');
    if (!container) return;

    const bitrateOptions = {
      aac: ['96k', '128k', '160k', '192k', '256k', '320k'],
      ac3: ['192k', '224k', '256k', '320k', '384k', '448k', '512k', '640k'],
      eac3: ['96k', '128k', '192k', '256k', '384k', '448k', '512k', '640k', '768k'],
      mp3: ['96k', '128k', '160k', '192k', '256k', '320k'],
      flac: ['lossless'],
      copy: ['original']
    };

    const options = bitrateOptions[codec] || ['192k'];

    container.innerHTML = '';
    container.style.display = options.length > 1 ? 'block' : 'none';
    if (options.length <= 1) return;

    const audioBitrateLabelFallback = 'Audio Bitrate:';
    const losslessFallback = 'Lossless';
    const originalFallback = 'Original';

    const audioBitrateLabel = window.i18n ? this.t('label.audioBitrate', audioBitrateLabelFallback) : audioBitrateLabelFallback;
    const losslessText = window.i18n ? this.t('option.audioBitrateLossless', losslessFallback) : losslessFallback;
    const originalText = window.i18n ? this.t('option.audioBitrateOriginal', originalFallback) : originalFallback;

    container.innerHTML = `
      <label for="audioBitrateSelect" data-i18n="label.audioBitrate">${audioBitrateLabel}</label>
      <select id="audioBitrateSelect">
        ${options.map(bitrate =>
          `<option value="${bitrate}" ${bitrate === this.videoSettings.audioBitrate ? 'selected' : ''}>
            ${bitrate === 'lossless' ? losslessText : bitrate === 'original' ? originalText : bitrate}
          </option>`
        ).join('')}
      </select>
    `;

    const audioBitrateSelect = container.querySelector('#audioBitrateSelect');
    audioBitrateSelect?.addEventListener('change', (e) => {
      this.videoSettings.audioBitrate = e.target.value;
      this.saveToStorage();
    });

    if (window.i18n?.apply) window.i18n.apply(container);
  }


  isCodecAllowedByCaps(hardware, codecValue) {
    if (codecValue === 'auto' || codecValue === 'copy') return true;
    if (!this.ffmpegCaps) return true;

    const hw = String(hardware || 'off').toLowerCase();
    const is10 = /_10bit$/.test(codecValue);
    const base = codecValue.replace(/_10bit$/, '');
    const map = () => {
      if (hw === 'nvenc') {
      if (base === 'h264') return is10 ? 'h264_nvenc_10bit' : 'h264_nvenc';
      if (base === 'h265') return is10 ? (this.ffmpegCaps?.hevc_nvenc_10bit ? 'hevc_nvenc_10bit' : 'h265_nvenc_10bit')
                                      : (this.ffmpegCaps?.hevc_nvenc       ? 'hevc_nvenc'       : 'h265_nvenc');
      if (base === 'av1')  return is10 ? 'av1_nvenc_10bit'  : 'av1_nvenc';
    }
      if (hw === 'qsv' || hw === 'vaapi') return null;
      if (hw === 'off') {
        if (base === 'av1') {
          return null;
        }
      }
      return null;
    };

    const encKey = map();
      if (!encKey) {
      if (hw === 'off' && base === 'av1') {
        const svt = this.ffmpegCaps?.libsvtav1?.ok === true;
        const aom = this.ffmpegCaps?.libaom_av1?.ok === true;
        return (svt || aom);
      }
      return true;
    }

    const entry = this.ffmpegCaps?.[encKey];
      if (entry == null) return true;
      return entry.ok === true;
    }

  getSupportedCodecs(hardware) {
    const C = (value, nameKey, descKey, fallbackName, fallbackDesc) => ({
      value, nameKey, descKey, nameFallback: fallbackName, descFallback: fallbackDesc
    });

    const codecSupport = {
      off: {
        codecs: [
          C('auto', 'ui.codec.auto.name', 'ui.codec.auto.desc',
            'Auto (H.264 8-bit)',
            'Chooses H.264 for below 1080p, H.265 for 4K and above'),
          C('h264', 'ui.codec.h264.name', 'ui.codec.h264.desc',
            'H.264 8-bit (libx264)', 'Most common codec, compatible with all devices and platforms'),
          C('h264_10bit', 'ui.codec.h264_10bit.name', 'ui.codec.h264_10bit.desc',
            'H.264 10-bit (libx264)', '10-bit color depth (software)'),
          C('h265', 'ui.codec.h265.name', 'ui.codec.h265.desc',
            'H.265/HEVC 8-bit (libx265)', 'Better compression than H.264'),
          C('h265_10bit', 'ui.codec.h265_10bit.name', 'ui.codec.h265_10bit.desc',
            'H.265/HEVC 10-bit (libx265)', '10-bit HEVC, suitable for HDR'),
          C('av1', 'ui.codec.av1.name', 'ui.codec.av1.desc',
            'AV1 8-bit (software)', 'Best compression, slow encoding'),
          C('av1_10bit', 'ui.codec.av1_10bit.name', 'ui.codec.av1_10bit.desc',
            'AV1 10-bit (software)', '10-bit AV1 (very slow)'),
          C('vp9', 'ui.codec.vp9.name', 'ui.codec.vp9.desc',
            'VP9 8-bit (libvpx-vp9)', 'Web/YouTube codec'),
          C('vp9_10bit', 'ui.codec.vp9_10bit.name', 'ui.codec.vp9_10bit.desc',
            'VP9 10-bit (libvpx-vp9)', '10-bit VP9 for web'),
          C('x264', 'ui.codec.x264.name', 'ui.codec.x264.desc',
            'x264 (CPU)', 'CPU encoding, high quality, slower'),
          C('prores', 'ui.codec.prores.name', 'ui.codec.prores.desc',
            'Apple ProRes 422', 'Professional editing intermediate'),
          C('copy', 'ui.codec.copy.name', 'ui.codec.copy.desc',
            'Copy Original Codec', 'Keep the original video codec')
        ],
        hwSupportKey: 'ui.hwSupport.off',
        hwSupportFallback: 'CPU (software)'
      },

      nvenc: {
        codecs: [
          C('auto', 'ui.codec.auto.name', 'ui.codec.auto.desc',
            'Auto (H.264 8-bit)', 'Chooses H.264 for below 1080p, H.265 for 4K and above'),
          C('h264', 'ui.codec.h264_nvenc.name', 'ui.codec.h264_nvenc.desc',
            'H.264 8-bit (NVENC)', 'NVIDIA H.264 hardware encoding'),
          C('h264_10bit', 'ui.codec.h264_10bit_nvenc.name', 'ui.codec.h264_10bit_nvenc.desc',
            'H.264 10-bit (NVENC)', 'NVIDIA 10-bit H.264 (Turing+ GPU)'),
          C('h265', 'ui.codec.h265_nvenc.name', 'ui.codec.h265_nvenc.desc',
            'H.265/HEVC 8-bit (NVENC)', 'NVIDIA HEVC hardware encoding'),
          C('h265_10bit', 'ui.codec.h265_10bit_nvenc.name', 'ui.codec.h265_10bit_nvenc.desc',
            'H.265/HEVC 10-bit (NVENC)', 'NVIDIA 10-bit HEVC (Pascal+ GPU)'),
          C('av1', 'ui.codec.av1_nvenc.name', 'ui.codec.av1_nvenc.desc',
            'AV1 (NVENC)', 'NVIDIA AV1 (Ada Lovelace+ GPU)'),
          C('av1_10bit', 'ui.codec.av1_10bit_nvenc.name', 'ui.codec.av1_10bit_nvenc.desc',
            'AV1 10-bit (NVENC)', 'NVIDIA 10-bit AV1 (Ada Lovelace+ GPU)')
        ],
        hwSupportKey: 'ui.hwSupport.nvenc',
        hwSupportFallback: 'NVIDIA GPU (NVENC)'
      },

      qsv: {
        codecs: [
          C('auto', 'ui.codec.auto.name', 'ui.codec.auto.desc',
            'Auto (H.264 8-bit)', 'Chooses H.264 for below 1080p, H.265 for 4K and above'),
          C('h264', 'ui.codec.h264_qsv.name', 'ui.codec.h264_qsv.desc',
            'H.264 8-bit (QSV)', 'Intel H.264 hardware encoding'),
          C('h264_10bit', 'ui.codec.h264_10bit_qsv.name', 'ui.codec.h264_10bit_qsv.desc',
            'H.264 10-bit (QSV)', 'Intel 10-bit H.264 (Gen8+ platform)'),
          C('h265', 'ui.codec.h265_qsv.name', 'ui.codec.h265_qsv.desc',
            'H.265/HEVC 8-bit (QSV)', 'Intel HEVC hardware encoding'),
          C('h265_10bit', 'ui.codec.h265_10bit_qsv.name', 'ui.codec.h265_10bit_qsv.desc',
            'H.265/HEVC 10-bit (QSV)', 'Intel 10-bit HEVC (Gen9+ platform)'),
          C('av1', 'ui.codec.av1_qsv.name', 'ui.codec.av1_qsv.desc',
            'AV1 (QSV)', 'Intel AV1 (Gen12+ platform)'),
          C('av1_10bit', 'ui.codec.av1_10bit_qsv.name', 'ui.codec.av1_10bit_qsv.desc',
            'AV1 10-bit (QSV)', 'Intel 10-bit AV1 (Gen12+ platform)')
        ],
        hwSupportKey: 'ui.hwSupport.qsv',
        hwSupportFallback: 'Intel GPU (Quick Sync)'
      },

      vaapi: {
        codecs: [
          C('auto', 'ui.codec.auto.name', 'ui.codec.auto.desc',
            'Auto (H.264 8-bit)', 'Chooses H.264 for below 1080p, H.265 for 4K and above'),
          C('h264', 'ui.codec.h264_vaapi.name', 'ui.codec.h264_vaapi.desc',
            'H.264 8-bit (VAAPI)', 'AMD/Intel H.264 hardware encoding'),
          C('h264_10bit', 'ui.codec.h264_10bit_vaapi.name', 'ui.codec.h264_10bit_vaapi.desc',
            'H.264 10-bit (VAAPI)', 'AMD/Intel 10-bit H.264'),
          C('h265', 'ui.codec.h265_vaapi.name', 'ui.codec.h265_vaapi.desc',
            'H.265/HEVC 8-bit (VAAPI)', 'AMD/Intel HEVC hardware encoding'),
          C('h265_10bit', 'ui.codec.h265_10bit_vaapi.name', 'ui.codec.h265_10bit_vaapi.desc',
            'H.265/HEVC 10-bit (VAAPI)', 'AMD/Intel 10-bit HEVC'),
          C('av1', 'ui.codec.av1_vaapi.name', 'ui.codec.av1_vaapi.desc',
            'AV1 (VAAPI)', 'AMD/Intel AV1 (RDNA2+/Gen12+ GPU)'),
          C('av1_10bit', 'ui.codec.av1_10bit_vaapi.name', 'ui.codec.av1_10bit_vaapi.desc',
            'AV1 10-bit (VAAPI)', 'AMD/Intel 10-bit AV1'),
          C('vp9', 'ui.codec.vp9_vaapi.name', 'ui.codec.vp9_vaapi.desc',
            'VP9 (VAAPI)', 'AMD/Intel VP9 hardware encoding'),
          C('vp9_10bit', 'ui.codec.vp9_10bit_vaapi.name', 'ui.codec.vp9_10bit_vaapi.desc',
            'VP9 10-bit (VAAPI)', 'AMD/Intel 10-bit VP9')
        ],
        hwSupportKey: 'ui.hwSupport.vaapi',
        hwSupportFallback: 'AMD/Intel GPU (VAAPI)'
      }
    };

    return codecSupport[hardware] || codecSupport.off;
  }

  updateProresUIState(codecValue, hardware) {
    if (!this.modalEl) return;

    const hw = String(hardware || 'off').toLowerCase();
    const c = String(codecValue || 'auto').toLowerCase();
    const isProres = (hw === 'off' && c === 'prores');
    const swQuality = this.modalEl.querySelector('#swQuality');
    const swPreset  = this.modalEl.querySelector('#swPresetSelect');
    const swTune    = this.modalEl.querySelector('#swTuneSelect');
    const swProfile = this.modalEl.querySelector('#swProfileSelect');
    const swLevel   = this.modalEl.querySelector('#swLevelSelect');

    this.setDisabled(swQuality, isProres);
    this.setDisabled(swPreset,  isProres);
    this.setDisabled(swTune,    isProres);
    this.setDisabled(swProfile, isProres);
    this.setDisabled(swLevel,   isProres);

    const proresSel = this.modalEl.querySelector('#proresProfileSelect');

    const swHints = this.modalEl.querySelector('#swQualityValue')?.closest?.('.vs-range-row');
    if (swHints) swHints.style.opacity = isProres ? '0.55' : '';
  }

  updateProresVisibility(codecValue, hardware) {
    if (!this.modalEl) return;
    const group = this.modalEl.querySelector('#proresProfileGroup');
    const sel = this.modalEl.querySelector('#proresProfileSelect');
    if (!group || !sel) return;

    const hw = String(hardware || 'off').toLowerCase();
    const c = String(codecValue || 'auto').toLowerCase();

    const show = (hw === 'off' && c === 'prores');
    group.style.display = show ? 'block' : 'none';

    const cur = String(this.videoSettings.proresProfile ?? '2');
    if (show) {
      const allowed = new Set(['0','1','2','3','4','5']);
      const next = allowed.has(cur) ? cur : '2';
      this.videoSettings.proresProfile = next;
      sel.value = next;
    }
    this.updateProresUIState(codecValue, hardware);
  }

  updateVideoCodecOptions() {
    const videoCodecSelect = this.modalEl?.querySelector('#videoCodecSelect');
    const hwaccelSelect = this.modalEl?.querySelector('#hwaccelSelect');
    if (!videoCodecSelect || !hwaccelSelect) return;

    const hardware = hwaccelSelect.value || 'off';
    const supported = this.getSupportedCodecs(hardware);
    const currentCodec = this.videoSettings.videoCodec || 'auto';

    videoCodecSelect.innerHTML = '';

    const filtered = (supported.codecs || []).filter(c => this.isCodecAllowedByCaps(hardware, c.value));

    filtered.forEach(codec => {
      const option = document.createElement('option');
      option.value = codec.value;

      const name = this.t(codec.nameKey, codec.nameFallback);
      const desc = this.t(codec.descKey, codec.descFallback);

      option.textContent = name;
      option.dataset.desc = desc;
      videoCodecSelect.appendChild(option);
    });

    const hasCurrent = filtered.some(c => c.value === currentCodec);
    if (hasCurrent) {
      videoCodecSelect.value = currentCodec;
      if (currentCodec !== 'auto' && currentCodec !== 'copy') {
        this.updateEncoderSpecificOptions(currentCodec, hardware);
      }
    } else {
      videoCodecSelect.value = 'auto';
      this.videoSettings.videoCodec = 'auto';
      this.saveToStorage();
    }

    const codecDescription = this.modalEl?.querySelector('#codecDescription');
    const hwSupportInfo = this.modalEl?.querySelector('#hwSupportInfo');

    if (codecDescription) {
      const selectedOpt = videoCodecSelect.selectedOptions?.[0];
      codecDescription.textContent = selectedOpt?.dataset?.desc || '';
    }

    if (hwSupportInfo) {
      const hwText = this.t(supported.hwSupportKey, supported.hwSupportFallback);
      hwSupportInfo.textContent = `(${hwText})`;
      hwSupportInfo.style.display = 'inline';
    }

    const chosen = videoCodecSelect.value || 'auto';
    if (chosen !== 'auto' && chosen !== 'copy') {
      this.updateEncoderSpecificOptions(chosen, hardware);
    } else {
      this.normalizeTuneForContext(chosen, hardware);
    }
    this.updateProresVisibility(chosen, hardware);
    this.updateProresUIState(chosen, hardware);
  }

  getCodecInfo(codecValue) {
    const info = {
      auto: { nameKey: 'ui.codec.auto.name', descKey: 'ui.codec.auto.desc', nameFallback: 'Auto (H.264 8-bit)', descFallback: 'Chooses H.264 for below 1080p, H.265 for 4K and above' },
      h264: { nameKey: 'ui.codec.h264.name', descKey: 'ui.codec.h264.desc', nameFallback: 'H.264 8-bit', descFallback: 'Most common codec, compatible with all devices and platforms' },
      h264_10bit: { nameKey: 'ui.codec.h264_10bit.name', descKey: 'ui.codec.h264_10bit.desc', nameFallback: 'H.264 10-bit', descFallback: '10-bit color depth for smoother gradients' },
      h265: { nameKey: 'ui.codec.h265.name', descKey: 'ui.codec.h265.desc', nameFallback: 'H.265/HEVC 8-bit', descFallback: 'About 50% better compression than H.264, ideal for 4K' },
      h265_10bit: { nameKey: 'ui.codec.h265_10bit.name', descKey: 'ui.codec.h265_10bit.desc', nameFallback: 'H.265/HEVC 10-bit', descFallback: '10-bit H.265, suitable for HDR content' },
      av1: { nameKey: 'ui.codec.av1.name', descKey: 'ui.codec.av1.desc', nameFallback: 'AV1 8-bit', descFallback: 'Open-source, best compression, slower encoding' },
      av1_10bit: { nameKey: 'ui.codec.av1_10bit.name', descKey: 'ui.codec.av1_10bit.desc', nameFallback: 'AV1 10-bit', descFallback: '10-bit AV1, next-gen codec' },
      vp9: { nameKey: 'ui.codec.vp9.name', descKey: 'ui.codec.vp9.desc', nameFallback: 'VP9 8-bit', descFallback: 'Google codec, optimized for web and YouTube' },
      vp9_10bit: { nameKey: 'ui.codec.vp9_10bit.name', descKey: 'ui.codec.vp9_10bit.desc', nameFallback: 'VP9 10-bit', descFallback: '10-bit VP9 for YouTube and web video' },
      x264: { nameKey: 'ui.codec.x264.name', descKey: 'ui.codec.x264.desc', nameFallback: 'x264 (CPU)', descFallback: 'CPU encoding, highest quality, slower encoding' },
      prores: {
        nameKey: 'ui.codec.prores.name',
        descKey: 'ui.codec.prores.desc',
        nameFallback: 'Apple ProRes (Profile selectable)',
        descFallback: 'Editing intermediate codec. Choose profile (422 Proxy..4444 XQ) from settings.'
      },
      copy: { nameKey: 'ui.codec.copy.name', descKey: 'ui.codec.copy.desc', nameFallback: 'Original Codec', descFallback: 'Keep the original video codec; do not transcode' }
    };

    const entry = info[codecValue] || info.auto;
    return {
      name: this.t(entry.nameKey, entry.nameFallback),
      description: this.t(entry.descKey, entry.descFallback)
    };
  }

  getHardwareSupportInfo(codecValue, hardware) {
    const reqKey = `ui.hwRequirement.${codecValue}.${hardware}`;

    const fallbackMap = {
      h264_10bit: {
        nvenc: 'Requires an NVIDIA Turing+ GPU',
        qsv: 'Requires an Intel 8th gen+ platform',
        vaapi: 'Requires an AMD Polaris+ or Intel Gen8+ GPU'
      },
      h265_10bit: {
        nvenc: 'Requires an NVIDIA Pascal+ GPU',
        qsv: 'Requires an Intel Gen9+ platform',
        vaapi: 'Requires an AMD Vega+ or Intel Gen9+ GPU'
      },
      av1: {
        nvenc: 'Requires NVIDIA Ada Lovelace (RTX 40 series)',
        qsv: 'Requires an Intel Gen12+ platform',
        vaapi: 'Requires AMD RDNA2+ or Intel Gen12+ GPU'
      },
      av1_10bit: {
        nvenc: 'Requires NVIDIA Ada Lovelace (RTX 40 series)',
        qsv: 'Requires an Intel Gen12+ platform',
        vaapi: 'Requires AMD RDNA2+ or Intel Gen12+ GPU'
      },
      vp9: { vaapi: 'Requires an AMD Vega+ or Intel Gen9+ GPU' },
      vp9_10bit: { vaapi: 'Requires an AMD Vega+ or Intel Gen9+ GPU' }
    };

    const hw = String(hardware || 'off').toLowerCase();
    const fallback = fallbackMap?.[codecValue]?.[hw];
    if (!fallback) return null;

    const translated = this.t(reqKey, fallback);
    return `⚠️ ${translated}`;
  }

  bindModalEventsOnce() {
    if (this._modalEventsBound) return;
    this._modalEventsBound = true;

    const closeBtn = this.modalEl.querySelector('#vsModalClose');
    const cancelBtn = this.modalEl.querySelector('#vsCancelBtn');
    const applyBtn = this.modalEl.querySelector('#vsApplyBtn');

    closeBtn?.addEventListener('click', () => this.handleModalCancel());
    cancelBtn?.addEventListener('click', () => this.handleModalCancel());
    applyBtn?.addEventListener('click', () => this.handleModalApply());

    const hwaccelSelect = this.modalEl.querySelector('#hwaccelSelect');
    hwaccelSelect?.addEventListener('change', (e) => {
      this.videoSettings.hwaccel = e.target.value || 'off';
      this.saveToStorage();
      this.showEncoderSpecificSettings(this.videoSettings.hwaccel);
      this.updateVideoCodecOptions();
      this.saveToStorage();
    });

    const videoCodecSelect = this.modalEl.querySelector('#videoCodecSelect');
    videoCodecSelect?.addEventListener('change', (e) => {
      this.videoSettings.videoCodec = e.target.value || 'auto';

      const codecDescription = this.modalEl.querySelector('#codecDescription');
      const hwSupportInfo = this.modalEl.querySelector('#hwSupportInfo');
      const codecInfo = this.getCodecInfo(e.target.value);

      if (codecDescription) codecDescription.textContent = codecInfo.description || '';

      const currentHw = this.videoSettings.hwaccel || 'off';
      const supportInfo = this.getHardwareSupportInfo(e.target.value, currentHw);
      if (hwSupportInfo) {
        if (supportInfo) {
          hwSupportInfo.textContent = supportInfo;
          hwSupportInfo.style.display = 'inline';
        } else {
          const supported = this.getSupportedCodecs(currentHw);
          const hwText = this.t(supported.hwSupportKey, supported.hwSupportFallback);
          hwSupportInfo.textContent = `(${hwText})`;
          hwSupportInfo.style.display = 'inline';
        }
      }

      if (e.target.value !== 'auto' && e.target.value !== 'copy') {
        this.updateEncoderSpecificOptions(e.target.value, currentHw);
      } else {
        this.normalizeTuneForContext(e.target.value, currentHw);
      }
      this.updateProresVisibility(e.target.value, currentHw);
      this.updateProresUIState(e.target.value, currentHw);
      this.saveToStorage();
    });

    const hdrModeSelect = this.modalEl.querySelector('#hdrModeSelect');
    hdrModeSelect?.addEventListener('change', (e) => {
      this.videoSettings.hdrMode = e.target.value;
      this.updateHDRUI(e.target.value);
      this.saveToStorage();
    });

    const hdrToneMappingSelect = this.modalEl.querySelector('#hdrToneMappingSelect');
    hdrToneMappingSelect?.addEventListener('change', (e) => {
      this.videoSettings.hdrToneMapping = e.target.value;
      this.saveToStorage();
    });

    const hdrPeakBrightness = this.modalEl.querySelector('#hdrPeakBrightness');
    const hdrPeakBrightnessValue = this.modalEl.querySelector('#hdrPeakBrightnessValue');
    hdrPeakBrightness?.addEventListener('input', (e) => {
      this.videoSettings.hdrPeakBrightness = e.target.value;
      if (hdrPeakBrightnessValue) hdrPeakBrightnessValue.textContent = e.target.value;
      this.saveToStorage();
    });

    const fpsSelect = this.modalEl.querySelector('#fpsSelect');
    fpsSelect?.addEventListener('change', (e) => {
      this.videoSettings.fps = e.target.value || 'source';
      this.saveToStorage();
    });

    const orientationSelect = this.modalEl.querySelector('#orientationSelect');
    orientationSelect?.addEventListener('change', (e) => {
      this.videoSettings.orientation = e.target.value || 'auto';
      this.saveToStorage();
    });

    const resizeModeSelect = this.modalEl.querySelector('#resizeModeSelect');
    resizeModeSelect?.addEventListener('change', (e) => {
      this.videoSettings.resizeMode = e.target.value || 'scale';
      this.saveToStorage();
    });

    const cropEnabledCheckbox = this.modalEl.querySelector('#cropEnabledCheckbox');
    const cropBox = this.modalEl.querySelector('#cropSettingsBox');
    const toggleCropBox = (show) => { if (cropBox) cropBox.style.display = show ? 'block' : 'none'; };

    cropEnabledCheckbox?.addEventListener('change', (e) => {
      this.videoSettings.cropEnabled = !!e.target.checked;
      toggleCropBox(this.videoSettings.cropEnabled);
      this.saveToStorage();
    });

    const wireCrop = (id, key) => {
      const el = this.modalEl.querySelector(id);
      el?.addEventListener('input', (ev) => {
        this.videoSettings[key] = String(ev.target.value ?? '0');
        this.saveToStorage();
      });
    };
    wireCrop('#cropLeftInput', 'cropLeft');
    wireCrop('#cropRightInput', 'cropRight');
    wireCrop('#cropTopInput', 'cropTop');
    wireCrop('#cropBottomInput', 'cropBottom');

    const borderEnabledCheckbox = this.modalEl.querySelector('#borderEnabledCheckbox');
    const borderBox = this.modalEl.querySelector('#borderSettingsBox');
    const toggleBorderBox = (show) => { if (borderBox) borderBox.style.display = show ? 'block' : 'none'; };

    borderEnabledCheckbox?.addEventListener('change', (e) => {
      this.videoSettings.borderEnabled = !!e.target.checked;
      toggleBorderBox(this.videoSettings.borderEnabled);
      this.saveToStorage();
    });

    const borderSizeInput = this.modalEl.querySelector('#borderSizeInput');
    borderSizeInput?.addEventListener('input', (e) => {
      this.videoSettings.borderSize = String(e.target.value ?? '0');
      this.saveToStorage();
    });

    const borderColorInput = this.modalEl.querySelector('#borderColorInput');
    borderColorInput?.addEventListener('input', (e) => {
      this.videoSettings.borderColor = String(e.target.value ?? '#000000');
      this.saveToStorage();
    });

    const swQuality = this.modalEl.querySelector('#swQuality');
    const swQualityValue = this.modalEl.querySelector('#swQualityValue');
    swQuality?.addEventListener('input', (e) => {
      this.videoSettings.swSettings.quality = e.target.value;
      if (swQualityValue) swQualityValue.textContent = e.target.value;
      this.saveToStorage();
    });

    const swTuneSelect = this.modalEl.querySelector('#swTuneSelect');
    swTuneSelect?.addEventListener('change', (e) => {
      this.videoSettings.swSettings.tune = e.target.value;
      this.saveToStorage();
    });

    const swProfileSelect = this.modalEl.querySelector('#swProfileSelect');
    swProfileSelect?.addEventListener('change', (e) => {
      this.videoSettings.swSettings.profile = e.target.value;
      this.saveToStorage();
    });

    const swLevelSelect = this.modalEl.querySelector('#swLevelSelect');
    swLevelSelect?.addEventListener('change', (e) => {
      this.videoSettings.swSettings.level = e.target.value;
      this.saveToStorage();
    });

    const swPresetSelect = this.modalEl.querySelector('#swPresetSelect');
    swPresetSelect?.addEventListener('change', (e) => {
      this.videoSettings.swSettings.preset = e.target.value || 'veryfast';
      this.saveToStorage();
    });

    const colorRangeSelect = this.modalEl.querySelector('#colorRangeSelect');
    colorRangeSelect?.addEventListener('change', (e) => {
      this.videoSettings.colorRange = e.target.value || 'auto';
      this.saveToStorage();
    });

    const colorPrimariesSelect = this.modalEl.querySelector('#colorPrimariesSelect');
    colorPrimariesSelect?.addEventListener('change', (e) => {
      this.videoSettings.colorPrimaries = e.target.value || 'auto';
      this.saveToStorage();
    });

    const nvencPreset = this.modalEl.querySelector('#nvencPreset');
    nvencPreset?.addEventListener('change', (e) => {
      this.videoSettings.nvencSettings.preset = e.target.value;
      this.saveToStorage();
    });

    const nvencTuneSelect = this.modalEl.querySelector('#nvencTuneSelect');
    nvencTuneSelect?.addEventListener('change', (e) => {
      this.videoSettings.nvencSettings.tune = e.target.value;
      this.saveToStorage();
    });

    const nvencQuality = this.modalEl.querySelector('#nvencQuality');
    const nvencQualityValue = this.modalEl.querySelector('#nvencQualityValue');
    nvencQuality?.addEventListener('input', (e) => {
      this.videoSettings.nvencSettings.quality = e.target.value;
      if (nvencQualityValue) nvencQualityValue.textContent = e.target.value;
      this.saveToStorage();
    });

    const nvencProfileSelect = this.modalEl.querySelector('#nvencProfileSelect');
    nvencProfileSelect?.addEventListener('change', (e) => {
      this.videoSettings.nvencSettings.profile = e.target.value;
      this.saveToStorage();
    });

    const nvencLevelSelect = this.modalEl.querySelector('#nvencLevelSelect');
    nvencLevelSelect?.addEventListener('change', (e) => {
      this.videoSettings.nvencSettings.level = e.target.value;
      this.saveToStorage();
    });

    const qsvPreset = this.modalEl.querySelector('#qsvPreset');
    qsvPreset?.addEventListener('change', (e) => {
      this.videoSettings.qsvSettings.preset = e.target.value;
      this.saveToStorage();
    });

    const qsvTuneSelect = this.modalEl.querySelector('#qsvTuneSelect');
    qsvTuneSelect?.addEventListener('change', (e) => {
      this.videoSettings.qsvSettings.tune = '';
      e.target.value = '';
      this.saveToStorage();
    });

    const qsvQuality = this.modalEl.querySelector('#qsvQuality');
    const qsvQualityValue = this.modalEl.querySelector('#qsvQualityValue');
    qsvQuality?.addEventListener('input', (e) => {
      this.videoSettings.qsvSettings.quality = e.target.value;
      if (qsvQualityValue) qsvQualityValue.textContent = e.target.value;
      this.saveToStorage();
    });

    const qsvProfileSelect = this.modalEl.querySelector('#qsvProfileSelect');
    qsvProfileSelect?.addEventListener('change', (e) => {
      this.videoSettings.qsvSettings.profile = e.target.value;
      this.saveToStorage();
    });

    const qsvLevelSelect = this.modalEl.querySelector('#qsvLevelSelect');
    qsvLevelSelect?.addEventListener('change', (e) => {
      this.videoSettings.qsvSettings.level = 'auto';
      e.target.value = 'auto';
      this.saveToStorage();
    });

    const vaapiDevice = this.modalEl.querySelector('#vaapiDevice');
    vaapiDevice?.addEventListener('input', (e) => {
      this.videoSettings.vaapiSettings.device = e.target.value;
      this.saveToStorage();
    });

    const vaapiTuneSelect = this.modalEl.querySelector('#vaapiTuneSelect');
    vaapiTuneSelect?.addEventListener('change', (e) => {
      this.videoSettings.vaapiSettings.tune = '';
      e.target.value = '';
      this.saveToStorage();
    });

    const vaapiQuality = this.modalEl.querySelector('#vaapiQuality');
    const vaapiQualityValue = this.modalEl.querySelector('#vaapiQualityValue');
    vaapiQuality?.addEventListener('input', (e) => {
      this.videoSettings.vaapiSettings.quality = e.target.value;
      if (vaapiQualityValue) vaapiQualityValue.textContent = e.target.value;
      this.saveToStorage();
    });

    const vaapiProfileSelect = this.modalEl.querySelector('#vaapiProfileSelect');
    vaapiProfileSelect?.addEventListener('change', (e) => {
      this.videoSettings.vaapiSettings.profile = e.target.value;
      this.saveToStorage();
    });

    const vaapiLevelSelect = this.modalEl.querySelector('#vaapiLevelSelect');
    vaapiLevelSelect?.addEventListener('change', (e) => {
      this.videoSettings.vaapiSettings.level = 'auto';
      e.target.value = 'auto';
      this.saveToStorage();
    });

    const widthModeSelect = this.modalEl.querySelector('#widthModeSelect');
    const customWidthInput = this.modalEl.querySelector('#customWidthInput');

    const syncW = () => {
      const mode = widthModeSelect?.value || 'auto';
      if (customWidthInput) customWidthInput.disabled = (mode !== 'custom');
    };

    widthModeSelect?.addEventListener('change', (e) => {
      const mode = e.target.value || 'auto';
      this.videoSettings.scaleMode = mode;

      if (mode !== 'custom') {
        this.videoSettings.targetWidth = '';
        if (customWidthInput) customWidthInput.value = '';
      }

      syncW();
      this.saveToStorage();
  });

    customWidthInput?.addEventListener('input', (e) => {
      this.videoSettings.targetWidth = e.target.value;
      this.saveToStorage();
    });

    const heightModeSelect = this.modalEl.querySelector('#heightModeSelect');
    const customHeightInput = this.modalEl.querySelector('#customHeightInput');
    const allowUpscaleCheckbox = this.modalEl.querySelector('#allowUpscaleCheckbox');

    const syncH = () => {
      const mode = heightModeSelect?.value || 'auto';
      const isCustom = mode === 'custom';
      if (customHeightInput) customHeightInput.disabled = !isCustom;
      if (allowUpscaleCheckbox) allowUpscaleCheckbox.disabled = !isCustom;
    };

    heightModeSelect?.addEventListener('change', (e) => {
    const mode = e.target.value || 'auto';
    this.videoSettings.heightMode = mode;

    if (mode !== 'custom') {
      this.videoSettings.targetHeight = '';
      this.videoSettings.allowUpscale = false;
      if (customHeightInput) customHeightInput.value = '';
      if (allowUpscaleCheckbox) allowUpscaleCheckbox.checked = false;
    }

    syncH();
    this.saveToStorage();
  });

    customHeightInput?.addEventListener('input', (e) => {
      this.videoSettings.targetHeight = e.target.value;
      this.saveToStorage();
    });

    allowUpscaleCheckbox?.addEventListener('change', (e) => {
      this.videoSettings.allowUpscale = !!e.target.checked;
      this.saveToStorage();
    });

    const audioTranscodeCheckbox = this.modalEl.querySelector('#audioTranscodeCheckbox');
    audioTranscodeCheckbox?.addEventListener('change', (e) => {
      this.videoSettings.audioTranscodeEnabled = !!e.target.checked;
      this.toggleAudioCodecSettings(this.videoSettings.audioTranscodeEnabled);
      this.saveToStorage();
    });

    const audioCodecSelect = this.modalEl.querySelector('#audioCodecSelect');
    audioCodecSelect?.addEventListener('change', (e) => {
      this.videoSettings.audioCodec = e.target.value;
      this.updateAudioBitrateOptions(e.target.value);
      this.normalizeAudioSampleRateUI();
      this.saveToStorage();
    });

    const audioChannelsSelect = this.modalEl.querySelector('#audioChannelsSelect');
    audioChannelsSelect?.addEventListener('change', (e) => {
      this.videoSettings.audioChannels = e.target.value;
      this.saveToStorage();
    });

    const audioSampleRateSelect = this.modalEl.querySelector('#audioSampleRateSelect');
    audioSampleRateSelect?.addEventListener('change', (e) => {
      this.videoSettings.audioSampleRate = e.target.value;
      this.saveToStorage();
    });
  }

  updateHDRUI(hdrMode) {
  const toneMappingGroup = this.modalEl.querySelector('#hdrToneMappingGroup');
  const peakBrightnessGroup = this.modalEl.querySelector('#hdrPeakBrightnessGroup');

  if (hdrMode === 'tonemap_to_sdr') {
    if (toneMappingGroup) toneMappingGroup.style.display = 'block';
    if (peakBrightnessGroup) peakBrightnessGroup.style.display = 'block';
  } else {
    if (toneMappingGroup) toneMappingGroup.style.display = 'none';
    if (peakBrightnessGroup) peakBrightnessGroup.style.display = 'none';
  }
}

  syncModalUIFromState() {
    if (!this.modalEl) return;

    const swPresetSelect = this.modalEl.querySelector('#swPresetSelect');
    if (swPresetSelect) swPresetSelect.value = this.videoSettings.swSettings?.preset || 'veryfast';

    const crSel = this.modalEl.querySelector('#colorRangeSelect');
    if (crSel) crSel.value = this.videoSettings.colorRange || 'auto';

    const cpSel = this.modalEl.querySelector('#colorPrimariesSelect');
    if (cpSel) cpSel.value = this.videoSettings.colorPrimaries || 'auto';

    const hwaccelSelect = this.modalEl.querySelector('#hwaccelSelect');
    if (hwaccelSelect) hwaccelSelect.value = this.videoSettings.hwaccel || 'off';

    const fpsSelect = this.modalEl.querySelector('#fpsSelect');
    if (fpsSelect) fpsSelect.value = String(this.videoSettings.fps || 'source');

    const orientationSelect = this.modalEl.querySelector('#orientationSelect');
    if (orientationSelect) orientationSelect.value = this.videoSettings.orientation || 'auto';

    const resizeModeSelect = this.modalEl.querySelector('#resizeModeSelect');
    if (resizeModeSelect) resizeModeSelect.value = this.videoSettings.resizeMode || 'scale';

    const cropEnabledCheckbox = this.modalEl.querySelector('#cropEnabledCheckbox');
    const cropBox = this.modalEl.querySelector('#cropSettingsBox');
    if (cropEnabledCheckbox) cropEnabledCheckbox.checked = !!this.videoSettings.cropEnabled;
    if (cropBox) cropBox.style.display = this.videoSettings.cropEnabled ? 'block' : 'none';

    const cropLeftInput = this.modalEl.querySelector('#cropLeftInput');
    const cropRightInput = this.modalEl.querySelector('#cropRightInput');
    const cropTopInput = this.modalEl.querySelector('#cropTopInput');
    const cropBottomInput = this.modalEl.querySelector('#cropBottomInput');
    if (cropLeftInput) cropLeftInput.value = String(this.videoSettings.cropLeft ?? '0');
    if (cropRightInput) cropRightInput.value = String(this.videoSettings.cropRight ?? '0');
    if (cropTopInput) cropTopInput.value = String(this.videoSettings.cropTop ?? '0');
    if (cropBottomInput) cropBottomInput.value = String(this.videoSettings.cropBottom ?? '0');

    const borderEnabledCheckbox = this.modalEl.querySelector('#borderEnabledCheckbox');
    const borderBox = this.modalEl.querySelector('#borderSettingsBox');
    const borderSizeInput = this.modalEl.querySelector('#borderSizeInput');
    const borderColorInput = this.modalEl.querySelector('#borderColorInput');
    if (borderEnabledCheckbox) borderEnabledCheckbox.checked = !!this.videoSettings.borderEnabled;
    if (borderBox) borderBox.style.display = this.videoSettings.borderEnabled ? 'block' : 'none';
    if (borderSizeInput) borderSizeInput.value = String(this.videoSettings.borderSize ?? '0');
    if (borderColorInput) borderColorInput.value = String(this.videoSettings.borderColor ?? '#000000');

    this.showEncoderSpecificSettings(this.videoSettings.hwaccel || 'off');
    this.updateVideoCodecOptions();

    const c = this.videoSettings.videoCodec || 'auto';
    const h = this.videoSettings.hwaccel || 'off';
    if (c !== 'auto' && c !== 'copy') this.updateEncoderSpecificOptions(c, h);
    else this.normalizeTuneForContext(c, h);

    const nvencPreset = this.modalEl.querySelector('#nvencPreset');
    if (nvencPreset) nvencPreset.value = this.videoSettings.nvencSettings?.preset || 'p4';

    const nvencTuneSelect = this.modalEl.querySelector('#nvencTuneSelect');
    if (nvencTuneSelect) nvencTuneSelect.value = this.videoSettings.nvencSettings?.tune ?? '';

    const nvencQuality = this.modalEl.querySelector('#nvencQuality');
    const nvencQualityValue = this.modalEl.querySelector('#nvencQualityValue');
    if (nvencQuality) nvencQuality.value = this.videoSettings.nvencSettings?.quality || '23';
    if (nvencQualityValue) nvencQualityValue.textContent = String(this.videoSettings.nvencSettings?.quality || '23');

    const nvencProfileSelect = this.modalEl.querySelector('#nvencProfileSelect');
    if (nvencProfileSelect) nvencProfileSelect.value = this.videoSettings.nvencSettings?.profile || 'high';

    const nvencLevelSelect = this.modalEl.querySelector('#nvencLevelSelect');
    if (nvencLevelSelect) nvencLevelSelect.value = this.videoSettings.nvencSettings?.level || '4.0';

    const swQuality = this.modalEl.querySelector('#swQuality');
    const swQualityValue = this.modalEl.querySelector('#swQualityValue');
    if (swQuality) swQuality.value = this.videoSettings.swSettings?.quality || '23';
    if (swQualityValue) swQualityValue.textContent = String(this.videoSettings.swSettings?.quality || '23');

    const swTuneSelect = this.modalEl.querySelector('#swTuneSelect');
    if (swTuneSelect) swTuneSelect.value = this.videoSettings.swSettings?.tune || '';

    const swProfileSelect = this.modalEl.querySelector('#swProfileSelect');
    if (swProfileSelect) swProfileSelect.value = this.videoSettings.swSettings?.profile || 'high';

    const swLevelSelect = this.modalEl.querySelector('#swLevelSelect');
    if (swLevelSelect) swLevelSelect.value = this.videoSettings.swSettings?.level || '4.0';

    const proresSel = this.modalEl.querySelector('#proresProfileSelect');
    if (proresSel) {
      proresSel.value = String(this.videoSettings.proresProfile ?? '2');
      this.updateProresVisibility(this.videoSettings.videoCodec || 'auto', this.videoSettings.hwaccel || 'off');
    }
    this.updateProresUIState(this.videoSettings.videoCodec || 'auto', this.videoSettings.hwaccel || 'off');

    const qsvPreset = this.modalEl.querySelector('#qsvPreset');
    if (qsvPreset) qsvPreset.value = this.videoSettings.qsvSettings?.preset || 'veryfast';

    const qsvTuneSelect = this.modalEl.querySelector('#qsvTuneSelect');
    if (qsvTuneSelect) qsvTuneSelect.value = '';

    const qsvQuality = this.modalEl.querySelector('#qsvQuality');
    const qsvQualityValue = this.modalEl.querySelector('#qsvQualityValue');
    if (qsvQuality) qsvQuality.value = this.videoSettings.qsvSettings?.quality || '26';
    if (qsvQualityValue) qsvQualityValue.textContent = String(this.videoSettings.qsvSettings?.quality || '26');

    const qsvProfileSelect = this.modalEl.querySelector('#qsvProfileSelect');
    if (qsvProfileSelect) qsvProfileSelect.value = this.videoSettings.qsvSettings?.profile || 'main';

    const qsvLevelSelect = this.modalEl.querySelector('#qsvLevelSelect');
    if (qsvLevelSelect) {
      qsvLevelSelect.value = 'auto';
      qsvLevelSelect.disabled = true;
    }

    const vaapiDevice = this.modalEl.querySelector('#vaapiDevice');
    if (vaapiDevice) vaapiDevice.value = this.videoSettings.vaapiSettings?.device || '/dev/dri/renderD128';

    const vaapiTuneSelect = this.modalEl.querySelector('#vaapiTuneSelect');
    if (vaapiTuneSelect) vaapiTuneSelect.value = '';

    const vaapiQuality = this.modalEl.querySelector('#vaapiQuality');
    const vaapiQualityValue = this.modalEl.querySelector('#vaapiQualityValue');
    if (vaapiQuality) vaapiQuality.value = this.videoSettings.vaapiSettings?.quality || '26';
    if (vaapiQualityValue) vaapiQualityValue.textContent = String(this.videoSettings.vaapiSettings?.quality || '26');

    const vaapiProfileSelect = this.modalEl.querySelector('#vaapiProfileSelect');
    if (vaapiProfileSelect) vaapiProfileSelect.value = this.videoSettings.vaapiSettings?.profile || 'main';

    const vaapiLevelSelect = this.modalEl.querySelector('#vaapiLevelSelect');
    if (vaapiLevelSelect) {
      vaapiLevelSelect.value = 'auto';
      vaapiLevelSelect.disabled = true;
    }

    const widthModeSelect = this.modalEl.querySelector('#widthModeSelect');
    const customWidthInput = this.modalEl.querySelector('#customWidthInput');
    if (widthModeSelect) widthModeSelect.value = this.videoSettings.scaleMode || 'auto';
    if (customWidthInput) customWidthInput.value = this.videoSettings.targetWidth ?? '';
    if (customWidthInput) customWidthInput.disabled = (this.videoSettings.scaleMode !== 'custom');

    const heightModeSelect = this.modalEl.querySelector('#heightModeSelect');
    const customHeightInput = this.modalEl.querySelector('#customHeightInput');
    const allowUpscaleCheckbox = this.modalEl.querySelector('#allowUpscaleCheckbox');

    if (heightModeSelect) heightModeSelect.value = this.videoSettings.heightMode || 'auto';
    if (customHeightInput) customHeightInput.value = this.videoSettings.targetHeight ?? '';
    if (allowUpscaleCheckbox) allowUpscaleCheckbox.checked = !!this.videoSettings.allowUpscale;

    const isCustomH = (this.videoSettings.heightMode === 'custom');
    if (customHeightInput) customHeightInput.disabled = !isCustomH;
    if (allowUpscaleCheckbox) allowUpscaleCheckbox.disabled = !isCustomH;

    const audioTranscodeCheckbox = this.modalEl.querySelector('#audioTranscodeCheckbox');
    if (audioTranscodeCheckbox) audioTranscodeCheckbox.checked = !!this.videoSettings.audioTranscodeEnabled;

    this.toggleAudioCodecSettings(!!this.videoSettings.audioTranscodeEnabled);

    const audioCodecSelect = this.modalEl.querySelector('#audioCodecSelect');
    if (audioCodecSelect) audioCodecSelect.value = this.videoSettings.audioCodec || 'aac';

    const audioChannelsSelect = this.modalEl.querySelector('#audioChannelsSelect');
    if (audioChannelsSelect) audioChannelsSelect.value = this.videoSettings.audioChannels || 'original';

    const audioSampleRateSelect = this.modalEl.querySelector('#audioSampleRateSelect');
    if (audioSampleRateSelect) audioSampleRateSelect.value = this.videoSettings.audioSampleRate || '48000';

    this.updateAudioBitrateOptions(this.videoSettings.audioCodec);
    this.normalizeAudioSampleRateUI();
    this.normalizeTuneForContext(this.videoSettings.videoCodec || 'auto', this.videoSettings.hwaccel || 'off');

    const hdrModeSelect = this.modalEl.querySelector('#hdrModeSelect');
    if (hdrModeSelect) hdrModeSelect.value = this.videoSettings.hdrMode || 'auto';

    const hdrToneMappingSelect = this.modalEl.querySelector('#hdrToneMappingSelect');
    if (hdrToneMappingSelect) hdrToneMappingSelect.value = this.videoSettings.hdrToneMapping || 'hable';

    const hdrPeakBrightness = this.modalEl.querySelector('#hdrPeakBrightness');
    const hdrPeakBrightnessValue = this.modalEl.querySelector('#hdrPeakBrightnessValue');
    if (hdrPeakBrightness) hdrPeakBrightness.value = this.videoSettings.hdrPeakBrightness || '1000';
    if (hdrPeakBrightnessValue) hdrPeakBrightnessValue.textContent = String(this.videoSettings.hdrPeakBrightness || '1000');

    this.updateHDRUI(this.videoSettings.hdrMode || 'auto');
  }

    handleLanguageChanged() {
      try {
        const container = document.getElementById('videoSettingsContainer');
        if (container && window.i18n?.apply) window.i18n.apply(container);

        if (!this.modalEl) return;
        if (window.i18n?.apply) window.i18n.apply(this.modalEl);

        const hw = this.videoSettings.hwaccel || 'off';
        const codec = this.videoSettings.videoCodec || 'auto';

        this.updateVideoCodecOptions();
        this.updateEncoderSpecificOptions(codec, hw);
        this.updateTuneOptions(
          (this.tuneOptions[codec.replace(/_10bit$/, '')] || this.tuneOptions.default),
          hw,
          codec.replace(/_10bit$/, '')
        );
        this.updateLevelOptions(hw, codec);

        this.updateProresVisibility(codec, hw);
        this.updateProresUIState(codec, hw);

        const currentAudioCodec = this.videoSettings.audioCodec || 'aac';
        this.updateAudioBitrateOptions(currentAudioCodec);
        this.normalizeAudioSampleRateUI();

      } catch (e) {
        console.warn('[VideoSettingsManager] handleLanguageChanged failed:', e);
      }
    }

  getSettings() {
    return { ...this.videoSettings };
  }
}
