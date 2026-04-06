export class FormatManager {
    // Initializes class state and defaults for the browser UI layer.
    constructor(app) {
        this.app = app;
        this.cachedFormats = [];
    }

    // Loads formats for the browser UI layer.
    async loadFormats() {
        try {
            const response = await fetch('/api/formats');
            const data = await response.json();
            this.cachedFormats = Array.isArray(data.formats) ? data.formats : [];
            this.updateFormatOptions(data.formats);
            this.handleFormatChange();
            this.refreshFormatUI();
        } catch (error) {
            console.error('Failed to load formats:', error);
        }
    }

    // Handles handle format change in the browser UI layer.
    handleFormatChange() {
        const formatSelect = document.getElementById('formatSelect');
        const refresh = async () => {
            await this.refreshFormatUI();
            this.app.persistRingtoneSettingsToStorage();
        };
        formatSelect.addEventListener('change', async (e) => {
            await refresh(e.target.value);
        });

        ['outputModeSelect', 'ringtoneTargetSelect', 'ringtoneModeSelect'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => {
                    refresh();
                });
            }
        });

        const durationInput = document.getElementById('ringtoneDurationInput');
        if (durationInput) {
            durationInput.addEventListener('input', () => {
                this.syncRingtoneDurationLimit();
                this.app.persistRingtoneSettingsToStorage();
            });
            durationInput.addEventListener('change', () => {
                this.syncRingtoneDurationLimit();
                this.app.persistRingtoneSettingsToStorage();
            });
        }

        ['ringtoneFadeInSelect', 'ringtoneFadeOutSelect'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => {
                    this.app.persistRingtoneSettingsToStorage();
                });
            }
        });

        const startInput = document.getElementById('ringtoneStartInput');
        if (startInput) {
            const persistStart = () => this.app.persistRingtoneSettingsToStorage();
            startInput.addEventListener('input', persistStart);
            startInput.addEventListener('change', persistStart);
        }

        refresh();
    }

    // Builds a sample rate label for the browser UI layer.
    getSampleRateOptionLabel(rate) {
        const rateNumber = Number(rate);
        const translatedLabels = {
            44100: this.app.t('quality.44100') || '44.1 kHz (CD Quality)',
            48000: this.app.t('quality.48000') || '48 kHz (Standard)',
            96000: this.app.t('quality.96000') || '96 kHz (High Quality)',
            192000: this.app.t('quality.192000') || '192 kHz (Studio Quality)'
        };

        return translatedLabels[rateNumber] || `${Math.round(rateNumber / 1000)} kHz`;
    }

    // Rebuilds sample rate options for the browser UI layer.
    updateSampleRateOptions(rates, fallbackRate = null) {
        const sampleRateSelect = document.getElementById('sampleRateSelect');
        if (!sampleRateSelect) return;

        const normalizedRates = rates
            .map((rate) => Number(rate))
            .filter((rate) => Number.isFinite(rate) && rate > 0);
        if (!normalizedRates.length) return;

        sampleRateSelect.innerHTML = '';
        normalizedRates.forEach((rate) => {
            const option = document.createElement('option');
            option.value = String(rate);
            option.textContent = this.getSampleRateOptionLabel(rate);
            sampleRateSelect.appendChild(option);
        });

        const savedSampleRate = Number(
            this.app.loadSavedStandardAudioSettingsFromStorage?.()?.sampleRate
        );
        const preferredRate = normalizedRates.includes(savedSampleRate)
            ? savedSampleRate
            : (normalizedRates.includes(this.app.currentSampleRate)
                ? this.app.currentSampleRate
                : (normalizedRates.includes(Number(fallbackRate)) ? Number(fallbackRate) : normalizedRates[0]));

        sampleRateSelect.value = String(preferredRate);
        this.app.currentSampleRate = preferredRate;
    }

    // Updates sample rate options for standard audio formats in the browser UI layer.
    updateStandardSampleRateOptions() {
        this.updateSampleRateOptions([44100, 48000, 96000, 192000], 48000);
    }

    // Updates sample rate options for eac3 ac3 for the browser UI layer.
    updateSampleRateOptionsForEac3Ac3() {
        this.updateSampleRateOptions([48000, 44100, 32000], 48000);
    }

    // Handles toggle format specific options in the browser UI layer.
    toggleFormatSpecificOptions(format) {
        const isRingtoneMode = this.app.isRingtoneMode();
        const sampleRateGroup = document.querySelector('.form-group:has(#sampleRateSelect)');
        const lyricsGroup = document.getElementById('lyricsCheckboxContainer');
        const embedLyricsGroup = document.getElementById('embedLyricsCheckboxContainer');
        const formatGroup = document.getElementById('formatGroup');
        const isVideoOutput = !isRingtoneMode && (format === 'mp4' || format === 'mkv');
        const isEac3Ac3 = !isRingtoneMode && (format === 'eac3' || format === 'ac3' || format === 'aac' || format === 'dts');
        const isFlacWav = !isRingtoneMode && (format === 'flac' || format === 'wav');
        const isFlac = !isRingtoneMode && format === 'flac';

        const videoSettingsContainer = document.getElementById('videoSettingsContainer');
        if (videoSettingsContainer) {
            videoSettingsContainer.style.display = isVideoOutput ? 'flex' : 'none';
            if (isVideoOutput) {
            const vsm = this.app.videoSettingsManager || this.app.videoManager;
            if (vsm?.modalOpen && typeof vsm.showEncoderSpecificSettings === 'function') {
                vsm.showEncoderSpecificSettings(vsm.videoSettings?.hwaccel || 'off');
                if (typeof vsm.updateVideoCodecOptions === 'function') vsm.updateVideoCodecOptions();
            }
          }
        }

        if (sampleRateGroup) {
            sampleRateGroup.style.display = (isVideoOutput || isRingtoneMode) ? 'none' : '';
        }

        if (lyricsGroup) {
            lyricsGroup.style.display = (isVideoOutput || isEac3Ac3 || isRingtoneMode) ? 'none' : '';
        }
        if (embedLyricsGroup) {
            const canShowLyrics = !(isVideoOutput || isEac3Ac3 || isRingtoneMode);
            embedLyricsGroup.style.display = canShowLyrics ? 'flex' : 'none';
        }
        if (formatGroup) {
            formatGroup.style.display = isRingtoneMode ? 'none' : '';
        }
        let bitDepthGroup = document.getElementById('bitDepthGroup');

        if (isFlacWav && !bitDepthGroup) {
            bitDepthGroup = document.createElement('div');
            bitDepthGroup.className = 'form-group';
            bitDepthGroup.id = 'bitDepthGroup';
            bitDepthGroup.innerHTML = `
                <label for="bitDepthSelect" data-i18n="label.flacDepth">Bit Depth</label>
                <select id="bitDepthSelect"></select>
            `;

            const sampleRateGroupEl = document.querySelector('.form-group:has(#sampleRateSelect)');
            if (sampleRateGroupEl && sampleRateGroupEl.parentNode) {
                sampleRateGroupEl.parentNode.insertBefore(bitDepthGroup, sampleRateGroupEl.nextSibling);
            }
            if (window.i18n?.apply) {
               window.i18n.apply(bitDepthGroup);
           }
        }

        if (bitDepthGroup) {
            bitDepthGroup.style.display = isFlacWav ? '' : 'none';
        }

        let compressionGroup = document.getElementById('compressionGroup');
        if (isFlac && !compressionGroup) {
            compressionGroup = document.createElement('div');
            compressionGroup.className = 'form-group';
            compressionGroup.id = 'compressionGroup';
            compressionGroup.innerHTML = `
                <label for="compressionLevelRange" data-i18n="label.flacCompression">FLAC Compression Level</label>
                <div class="range-row">
                    <input id="compressionLevelRange" type="range" min="0" max="12" step="1" value="5" />
                    <span id="compressionLevelValue" class="muted">5</span>
                </div>
            `;

            const insertAfter =
                document.getElementById('bitDepthGroup') ||
                document.querySelector('.form-group:has(#sampleRateSelect)');

            if (insertAfter && insertAfter.parentNode) {
                insertAfter.parentNode.insertBefore(compressionGroup, insertAfter.nextSibling);
            }

            const rangeEl = compressionGroup.querySelector('#compressionLevelRange');
            const valueEl = compressionGroup.querySelector('#compressionLevelValue');
            if (rangeEl && valueEl) {
                rangeEl.addEventListener('input', () => {
                    valueEl.textContent = rangeEl.value;
                });
            }
            if (window.i18n?.apply) {
               window.i18n.apply(compressionGroup);
           }
        }

        if (compressionGroup) {
            compressionGroup.style.display = isFlac ? '' : 'none';
        }

        this.toggleEac3Ac3Options(isEac3Ac3);
        }

        // Refreshes all format-dependent controls in the browser UI layer.
        async refreshFormatUI() {
        const rawFormat = document.getElementById('formatSelect')?.value || 'mp3';
        const format = this.app.getEffectiveFormat(rawFormat);
        this.toggleRingtoneControls();
        this.app.updateQualityLabel(format);
        this.toggleFormatSpecificOptions(format);

        const formats = await this.getFormats();
        this.updateBitrateOptions(format, formats);
        this.app.setAutoZipVisibility(this.app.shouldShowAutoZipForCurrentUI());

        if (format === 'eac3' || format === 'ac3' || format === 'aac' || format === 'dts') {
            this.updateSampleRateOptionsForEac3Ac3();
        } else if (!this.app.isRingtoneMode() && !this.app.isVideoFormat(format)) {
            this.updateStandardSampleRateOptions();
        }
    }

        // Toggles ringtone-specific controls in the browser UI layer.
        toggleRingtoneControls() {
        const container = document.getElementById('ringtoneSettingsContainer');
        const manualGroup = document.getElementById('ringtoneManualStartGroup');
        const isRingtone = this.app.isRingtoneMode();
        const mode = document.getElementById('ringtoneModeSelect')?.value || 'auto';

        if (container) {
            container.style.display = isRingtone ? '' : 'none';
        }
        if (manualGroup) {
            manualGroup.style.display = (isRingtone && mode === 'manual') ? '' : 'none';
        }

        this.syncRingtoneDurationLimit();
        this.updateRingtoneHint();
    }

        // Synchronizes ringtone duration limit and clamp in the browser UI layer.
        syncRingtoneDurationLimit() {
        const target = this.app.getRingtoneTarget();
        const durationInput = document.getElementById('ringtoneDurationInput');
        if (!durationInput) return;
        const maxDuration = this.app.getRingtoneDurationLimit(target);
        durationInput.max = String(maxDuration);

        const rawValue = Number(durationInput.value || 30);
        const nextValue = Math.min(maxDuration, Math.max(5, Number.isFinite(rawValue) ? rawValue : 30));
        if (Number(durationInput.value) !== nextValue) {
            durationInput.value = String(nextValue);
        }
    }

        // Updates ringtone hint text in the browser UI layer.
        updateRingtoneHint() {
        const hint = document.getElementById('ringtoneHint');
        if (!hint) return;
        hint.textContent = this.app.t('ui.ringtoneHint', {
            target: this.app.getRingtoneTargetLabel(),
            max: this.app.getRingtoneDurationLimit()
        });
    }

        // Handles toggle eac3 ac3 options in the browser UI layer.
        toggleEac3Ac3Options(show) {
        let container = document.getElementById('eac3Ac3Options');

        if (!container && show) {
            container = document.createElement('div');
            container.id = 'eac3Ac3Options';
            container.className = 'form-group';
            container.innerHTML = `
                <div class="form-group">
                      <label for="stereoConvertSelect" data-i18n="label.stereoConvert">Kanal Ayarları:</label>
                      <select id="stereoConvertSelect">
                        <option value="auto" data-i18n="option.auto">Orijinal Kanal Sayısını Koru</option>
                        <option value="force" data-i18n="option.forceStereo">Stereo'ya Dönüştür (2 Kanal)</option>
                      </select>
                    </div>

            <div class="form-group">
                <label for="atempoSelect" data-i18n="label.atempoAdjust">Ses Hızı Düzeltme (FPS Uyumu):</label>
                <select id="atempoSelect">
                  <option value="none" data-i18n="option.none">Ses hızını değiştirme</option>
                  <option value="23976_24000" data-i18n="option.23976_24000">23.976 FPS → 24 FPS (TV/stream → sinema)</option>
                  <option value="23976_25000" data-i18n="option.23976_25000">23.976 FPS → 25 FPS (NTSC → PAL TV)</option>
                  <option value="24000_23976" data-i18n="option.24000_23976">24 FPS → 23.976 FPS (sinema → TV/stream)</option>
                  <option value="24000_25000" data-i18n="option.24000_25000">24 FPS → 25 FPS (sinema → PAL TV)</option>
                  <option value="25_24" data-i18n="option.25_24">25 FPS → 24 FPS (PAL TV → sinema)</option>
                  <option value="25_23976" data-i18n="option.25_23976">25 FPS → 23.976 FPS (PAL TV → NTSC/stream)</option>
                  <option value="30_23976" data-i18n="option.30_23976">30 FPS → 23.976 FPS (NTSC → film/TV)</option>
                  <option value="30_24" data-i18n="option.30_24">30 FPS → 24 FPS (NTSC → sinema)</option>
                  <option value="30000_25000" data-i18n="option.30000_25000">30 FPS → 25 FPS (NTSC → PAL TV)</option>
                </select>
            </div>
            `;

            const formatSelect = document.getElementById('formatSelect');
            formatSelect.parentNode.insertBefore(container, formatSelect.nextSibling);
        }

        if (container) {
            container.style.display = show ? 'flex' : 'none';
            if (show && window.i18n?.apply) window.i18n.apply(container);
        }
    }

    // Updates format options for the browser UI layer.
    updateFormatOptions(formats) {
        const formatSelect = document.getElementById('formatSelect');
        formatSelect.innerHTML = '';
        const visibleFormats = formats.filter((format) => !format.hidden);
        visibleFormats.forEach((format) => {
            const option = document.createElement('option');
            option.value = format.format;
            option.textContent = format.format.toUpperCase();
            formatSelect.appendChild(option);
        });
        const firstFormat = visibleFormats[0]?.format || 'mp3';
        this.updateBitrateOptions(this.app.getEffectiveFormat(firstFormat), formats);
        const currentFormat = this.app.getEffectiveFormat(formatSelect.value);
        this.toggleFormatSpecificOptions(currentFormat);
    }

    // Returns formats used for the browser UI layer.
    async getFormats() {
        if (this.cachedFormats.length) return this.cachedFormats;
        try {
            const response = await fetch('/api/formats');
            const data = await response.json();
            this.cachedFormats = Array.isArray(data.formats) ? data.formats : [];
            return this.cachedFormats;
        } catch {
            return [];
        }
    }

    // Updates bitrate options for the browser UI layer.
    updateBitrateOptions(format, formats) {
        const bitrateSelect = document.getElementById('bitrateSelect');
        const formatData = formats.find((f) => f.format === format);
        if (!formatData) return;
        const previousValue = bitrateSelect.value;
        bitrateSelect.innerHTML = '';
        formatData.bitrates.forEach((bitrate) => {
            const option = document.createElement('option');
            option.value = bitrate;
            option.textContent = bitrate === 'lossless' ? this.app.t('quality.lossless') : bitrate;
            bitrateSelect.appendChild(option);
        });
        const availableBitrates = formatData.bitrates || [];
        const defaultBitrate = formatData.defaultBitrate || availableBitrates[0];
        const isStandardAudioSelection = !this.app.isRingtoneMode() && !this.app.isVideoFormat(format);
        const savedBitrate = isStandardAudioSelection
            ? this.app.getSavedStandardBitrate(format)
            : '';
        const fallbackBitrate = isStandardAudioSelection && availableBitrates.includes('auto')
            ? 'auto'
            : defaultBitrate;

        bitrateSelect.value = availableBitrates.includes(previousValue)
            ? previousValue
            : (availableBitrates.includes(savedBitrate) ? savedBitrate : fallbackBitrate);
        this.app.updateQualityLabel(format);
        const bitDepthSelect = document.getElementById('bitDepthSelect');
        if (bitDepthSelect) {
            bitDepthSelect.innerHTML = '';
            if (formatData.bitDepths && formatData.bitDepths.length) {
                formatData.bitDepths.forEach((depth) => {
                    const opt = document.createElement('option');
                    opt.value = depth;
                    opt.textContent = depth === '32f' ? '32-bit Float' : `${depth}-bit`;
                    bitDepthSelect.appendChild(opt);
                });
                if (bitDepthSelect.parentElement) {
                    bitDepthSelect.parentElement.style.display = '';
                }
            } else if (bitDepthSelect.parentElement) {
                bitDepthSelect.parentElement.style.display = 'none';
            }
        }
    }
}
