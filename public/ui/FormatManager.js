export class FormatManager {
    constructor(app) {
        this.app = app;
    }

    async loadFormats() {
        try {
            const response = await fetch('/api/formats');
            const data = await response.json();
            this.updateFormatOptions(data.formats);
            this.handleFormatChange();
        } catch (error) {
            console.error('Failed to load formats:', error);
        }
    }

    handleFormatChange() {
        const formatSelect = document.getElementById('formatSelect');
        formatSelect.addEventListener('change', async (e) => {
            const format = e.target.value;
            this.toggleFormatSpecificOptions(format);

            const formats = await this.getFormats();
            this.updateBitrateOptions(format, formats);

            if (format === 'eac3' || format === 'ac3' || format === 'aac') {
             this.updateSampleRateOptionsForEac3Ac3();
            }
        });

        const currentFormat = formatSelect.value;
        this.toggleFormatSpecificOptions(currentFormat);

        if (currentFormat === 'eac3' || currentFormat === 'ac3' || currentFormat === 'aac') {
         this.updateSampleRateOptionsForEac3Ac3();
     }
    }

    updateSampleRateOptionsForEac3Ac3() {
     const sampleRateSelect = document.getElementById('sampleRateSelect');
     if (!sampleRateSelect) return;
     const supportedRates = [48000, 44100, 32000];

     sampleRateSelect.innerHTML = '';
     supportedRates.forEach(rate => {
         const option = document.createElement('option');
         option.value = rate;
         option.textContent = `${Math.round(rate / 1000)} kHz`;
         if (rate === 48000) option.selected = true;
         sampleRateSelect.appendChild(option);
     });

     if (this.app.currentSampleRate && supportedRates.includes(this.app.currentSampleRate)) {
         sampleRateSelect.value = this.app.currentSampleRate;
     }
 }

    toggleFormatSpecificOptions(format) {
        const sampleRateGroup = document.querySelector('.form-group:has(#sampleRateSelect)');
        const lyricsGroup = document.getElementById('lyricsCheckboxContainer');
        const isMp4 = format === 'mp4';
        const isEac3Ac3 = format === 'eac3' || format === 'ac3' || format === 'aac';
        const isFlacWav = format === 'flac' || format === 'wav';
        const isFlac = format === 'flac';

        const videoSettingsContainer = document.getElementById('videoSettingsContainer');
        if (videoSettingsContainer) {
            videoSettingsContainer.style.display = isMp4 ? 'block' : 'none';
            if (isMp4) {
                this.app.videoManager.toggleEncoderSettings(this.app.videoManager.videoSettings.transcodeEnabled);
            }
        }

        if (sampleRateGroup) {
            sampleRateGroup.style.display = (isMp4) ? 'none' : '';
        }

        if (lyricsGroup) {
            lyricsGroup.style.display = (isMp4 || isEac3Ac3) ? 'none' : '';
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

    updateFormatOptions(formats) {
        const formatSelect = document.getElementById('formatSelect');
        formatSelect.innerHTML = '';
        formats.forEach((format) => {
            const option = document.createElement('option');
            option.value = format.format;
            option.textContent = format.format.toUpperCase();
            formatSelect.appendChild(option);
        });
        this.updateBitrateOptions(formats[0].format, formats);
        const currentFormat = formatSelect.value;
        this.toggleFormatSpecificOptions(currentFormat);
    }

    async getFormats() {
        try {
            const response = await fetch('/api/formats');
            const data = await response.json();
            return data.formats;
        } catch {
            return [];
        }
    }

    updateBitrateOptions(format, formats) {
        const bitrateSelect = document.getElementById('bitrateSelect');
        const formatData = formats.find((f) => f.format === format);
        if (!formatData) return;
        bitrateSelect.innerHTML = '';
        formatData.bitrates.forEach((bitrate) => {
            const option = document.createElement('option');
            option.value = bitrate;
            option.textContent = bitrate === 'lossless' ? this.app.t('quality.lossless') : bitrate;
            bitrateSelect.appendChild(option);
        });
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
