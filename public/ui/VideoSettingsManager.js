export class VideoSettingsManager {
    constructor(app) {
        this.app = app;
        this.videoSettings = {
            transcodeEnabled: false,
            audioTranscodeEnabled: false,
            audioCodec: 'aac',
            audioChannels: 'original',
            audioSampleRate: '48000',
            audioBitrate: '192k',
            hwaccel: 'off',
            fps: 'source',
            nvencSettings: { preset: 'fast', quality: '26' },
            qsvSettings: { preset: 'veryfast', quality: '26' },
            vaapiSettings: { device: '/dev/dri/renderD128', quality: '26' },
            volumeGain: 1.0
        };
    }

    initialize() {
        this.loadFromStorage();
        if (this.app) {
            this.app.currentVolumeGain = this.videoSettings.volumeGain ?? 1.0;
        }
        this.createUI();
        this.attachEvents();
    }

    loadFromStorage() {
        const saved = localStorage.getItem('videoSettings');
        if (saved) {
            try {
                this.videoSettings = { ...this.videoSettings, ...JSON.parse(saved) };
                this.videoSettings.audioTranscodeEnabled = this.videoSettings.audioTranscodeEnabled || false;
                this.videoSettings.audioCodec = this.videoSettings.audioCodec || 'aac';
                this.videoSettings.audioBitrate = this.videoSettings.audioBitrate || '192k';
                this.videoSettings.audioChannels = this.videoSettings.audioChannels || 'original';
                this.videoSettings.audioSampleRate = this.videoSettings.audioSampleRate || '48000';
            } catch (e) {
                console.warn('Video ayarları yüklenemedi:', e);
            }
        }
    }

    saveToStorage() {
        localStorage.setItem('videoSettings', JSON.stringify(this.videoSettings));
    }

    createUI() {
        const formatSelect = document.getElementById('formatSelect');
        if (!formatSelect) return;

        const videoSettingsContainer = document.createElement('div');
        videoSettingsContainer.id = 'videoSettingsContainer';
        videoSettingsContainer.className = 'video-settings-container';
        videoSettingsContainer.style.display = 'none';
        videoSettingsContainer.innerHTML = this.getVideoSettingsHTML();

        const bitrateGroup = document.querySelector('.form-group:has(#bitrateSelect)');
        if (bitrateGroup && bitrateGroup.parentNode) {
            bitrateGroup.parentNode.insertBefore(videoSettingsContainer, bitrateGroup.nextSibling);
        } else {
            formatSelect.parentNode.insertBefore(videoSettingsContainer, formatSelect.nextSibling);
        }

        if (window.i18n?.apply) {
            window.i18n.apply(videoSettingsContainer);
        }
    }

    getVideoSettingsHTML() {
        return `
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="videoTranscodeCheckbox" />
                    <span data-i18n="label.videoTranscode"></span>
                </label>
            </div>

            <div id="encoderSettingsGroup" class="encoder-settings-group" style="display: none;">
                <div class="form-group">
                    <label for="hwaccelSelect" data-i18n="label.hwaccel"></label>
                    <select id="hwaccelSelect">
                        <option value="off" data-i18n="option.software"></option>
                        <option value="nvenc" data-i18n="option.nvenc"></option>
                        <option value="qsv" data-i18n="option.qsv"></option>
                        <option value="vaapi" data-i18n="option.vaapi"></option>
                    </select>
                </div>

                <div class="form-group">
                    <label for="fpsSelect">FPS:</label>
                    <select id="fpsSelect">
                        <option value="source" data-i18n="option.videoNone"></option>
                        <option value="23.976" data-i18n="option.23976">23.976 FPS</option>
                        <option value="24" data-i18n="option.24">24 FPS</option>
                        <option value="25" data-i18n="option.25">25 FPS</option>
                        <option value="30" data-i18n="option.30">30 FPS</option>
                        <option value="50" data-i18n="option.50">50 FPS</option>
                        <option value="60" data-i18n="option.60">60 FPS</option>
                    </select>
                    <div class="muted" style="font-size: 12px; margin-top: 4px;">
                        <span data-i18n="option.note"></span>
                    </div>
                </div>

                <div id="nvencSettings" class="encoder-specific-settings" style="display: none;">
                    <div class="form-group">
                        <label for="nvencPreset" data-i18n="label.nvencPreset"></label>
                        <select id="nvencPreset">
                            <option value="slow" data-i18n="option.nvencSlow">slow (en iyi kalite)</option>
                            <option value="medium" data-i18n="option.nvencMedium">medium</option>
                            <option value="fast" selected data-i18n="option.nvencFast">fast</option>
                            <option value="hp" data-i18n="option.nvencHp">hp (high performance)</option>
                            <option value="hq" data-i18n="option.nvencHq">hq (high quality)</option>
                            <option value="bd" data-i18n="option.nvencBd">bd (blu-ray)</option>
                            <option value="ll" data-i18n="option.nvencLl">ll (low latency)</option>
                            <option value="llhq" data-i18n="option.nvencLlhq">llhq (low latency high quality)</option>
                            <option value="llhp" data-i18n="option.nvencLlhp">llhp (low latency high performance)</option>
                            <option value="lossless" data-i18n="option.nvencLossless">lossless</option>
                            <option value="losslesshp" data-i18n="option.nvencLosslesshp">losslesshp</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="nvencQuality" data-i18n="label.nvencQuality"></label>
                        <input type="range" id="nvencQuality" min="18" max="30" step="1" value="23" />
                        <span id="nvencQualityValue" class="range-value">23</span>
                        <div class="range-hints">
                            <span>18 (<span data-i18n="ui.bestQuality"></span>)</span>
                            <span>23 (<span data-i18n="ui.default"></span>)</span>
                            <span>30 (<span data-i18n="ui.fastest"></span>)</span>
                        </div>
                    </div>
                </div>

                <div id="qsvSettings" class="encoder-specific-settings" style="display: none;">
                    <div class="form-group">
                        <label for="qsvPreset" data-i18n="label.qsvPreset"></label>
                        <select id="qsvPreset">
                            <option value="veryfast" selected data-i18n="option.qsvVeryfast">veryfast</option>
                            <option value="faster" data-i18n="option.qsvFaster">faster</option>
                            <option value="fast" data-i18n="option.qsvFast">fast</option>
                            <option value="medium" data-i18n="option.qsvMedium">medium</option>
                            <option value="slow" data-i18n="option.qsvSlow">slow</option>
                            <option value="slower" data-i18n="option.qsvSlower">slower</option>
                            <option value="veryslow" data-i18n="option.qsvVeryslow">veryslow</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="qsvQuality" data-i18n="label.qsvQuality"></label>
                        <input type="range" id="qsvQuality" min="18" max="30" step="1" value="23" />
                        <span id="qsvQualityValue" class="range-value">23</span>
                        <div class="range-hints">
                            <span>18 (<span data-i18n="ui.bestQuality"></span>)</span>
                            <span>23 (<span data-i18n="ui.default"></span>)</span>
                            <span>30 (<span data-i18n="ui.fastest"></span>)</span>
                        </div>
                    </div>
                </div>

                <div id="vaapiSettings" class="encoder-specific-settings" style="display: none;">
                    <div class="form-group">
                        <label for="vaapiDevice" data-i18n="label.vaapiDevice"></label>
                        <input type="text" id="vaapiDevice" value="/dev/dri/renderD128" placeholder="/dev/dri/renderD128" />
                    </div>
                    <div class="form-group">
                        <label for="vaapiQuality" data-i18n="label.vaapiQuality"></label>
                        <input type="range" id="vaapiQuality" min="18" max="30" step="1" value="23" />
                        <span id="vaapiQualityValue" class="range-value">23</span>
                        <div class="range-hints">
                            <span>18 (<span data-i18n="ui.bestQuality"></span>)</span>
                            <span>23 (<span data-i18n="ui.default"></span>)</span>
                            <span>30 (<span data-i18n="ui.fastest"></span>)</span>
                        </div>
                    </div>
                </div>
            </div>

            <div id="audioTranscodeContainer" class="audio-transcode-container" style="display: none;">
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="audioTranscodeCheckbox" />
                        <span data-i18n="label.audioTranscode">Ses Codec'ini Değiştir</span>
                    </label>
                </div>

                <div id="audioCodecSettings" class="audio-codec-settings" style="display: none;">
                    <div class="form-group">
                        <label for="audioCodecSelect" data-i18n="label.format">Ses Codec:</label>
                        <select id="audioCodecSelect">
                            <option value="aac">AAC</option>
                            <option value="ac3">AC3</option>
                            <option value="eac3">E-AC3</option>
                            <option value="mp3">MP3</option>
                            <option value="flac">FLAC</option>
                            <option value="copy" data-i18n="label.copyFormat">Orijinal Ses (Copy)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="audioChannelsSelect" data-i18n="label.stereoConvert">Kanallar:</label>
                        <select id="audioChannelsSelect">
                            <option value="original" data-i18n="option.auto">Orijinal Kanal Sayısını Koru</option>
                            <option value="stereo" data-i18n="option.forceStereo">Stereo'ya Dönüştür (2 Kanal)</option>
                            <option value="mono" data-i18n="option.forceMono">Mono'ya Dönüştür (1 Kanal)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="audioSampleRateSelect" data-i18n="label.sampleRate">Örnekleme Hızı:</label>
                        <select id="audioSampleRateSelect">
                            <option value="original" data-i18n="option.none">Ses hızını değiştirme</option>
                            <option value="48000">48 kHz</option>
                            <option value="44100">44.1 kHz</option>
                            <option value="32000">32 kHz</option>
                            <option value="24000">24 kHz</option>
                            <option value="22050">22.05 kHz</option>
                        </select>
                    </div>
                    <div id="audioBitrateContainer" class="form-group" style="display: none;"></div>
                </div>
            </div>
        `;
    }

    attachEvents() {
        const transcodeCheckbox = document.getElementById('videoTranscodeCheckbox');
        if (transcodeCheckbox) {
            transcodeCheckbox.checked = this.videoSettings.transcodeEnabled;
            transcodeCheckbox.addEventListener('change', (e) => {
                this.videoSettings.transcodeEnabled = e.target.checked;
                this.toggleEncoderSettings(e.target.checked);
                const audioTranscodeContainer = document.getElementById('audioTranscodeContainer');
                if (audioTranscodeContainer) {
                    audioTranscodeContainer.style.display = e.target.checked ? 'block' : 'none';
                    if (!e.target.checked) {
                        this.videoSettings.audioTranscodeEnabled = false;
                        const audioTranscodeCheckbox = document.getElementById('audioTranscodeCheckbox');
                        if (audioTranscodeCheckbox) {
                            audioTranscodeCheckbox.checked = false;
                        }
                        this.toggleAudioCodecSettings(false);
                    }
                }
                this.saveToStorage();
            });
        }

        const audioTranscodeCheckbox = document.getElementById('audioTranscodeCheckbox');
        if (audioTranscodeCheckbox) {
            audioTranscodeCheckbox.checked = this.videoSettings.audioTranscodeEnabled;
            audioTranscodeCheckbox.addEventListener('change', (e) => {
                if (!this.videoSettings.transcodeEnabled) {
                    e.target.checked = false;
                    return;
                }
                this.videoSettings.audioTranscodeEnabled = e.target.checked;
                this.toggleAudioCodecSettings(e.target.checked);
                this.saveToStorage();
            });
        }

        const audioCodecSelect = document.getElementById('audioCodecSelect');
        if (audioCodecSelect) {
            audioCodecSelect.value = this.videoSettings.audioCodec;
            audioCodecSelect.addEventListener('change', (e) => {
                this.videoSettings.audioCodec = e.target.value;
                this.updateAudioBitrateOptions(e.target.value);
                this.saveToStorage();
            });
        }

        const audioChannelsSelect = document.getElementById('audioChannelsSelect');
        if (audioChannelsSelect) {
            audioChannelsSelect.value = this.videoSettings.audioChannels;
            audioChannelsSelect.addEventListener('change', (e) => {
                this.videoSettings.audioChannels = e.target.value;
                this.saveToStorage();
            });
        }

        const audioSampleRateSelect = document.getElementById('audioSampleRateSelect');
        if (audioSampleRateSelect) {
            audioSampleRateSelect.value = this.videoSettings.audioSampleRate;
            audioSampleRateSelect.addEventListener('change', (e) => {
                this.videoSettings.audioSampleRate = e.target.value;
                this.saveToStorage();
            });
        }

        this.updateAudioBitrateOptions(this.videoSettings.audioCodec);
        this.toggleAudioCodecSettings(this.videoSettings.audioTranscodeEnabled);
    }

    toggleAudioCodecSettings(show) {
        const audioCodecGroup = document.getElementById('audioCodecSettings');
        if (audioCodecGroup) {
            audioCodecGroup.style.display = show ? 'block' : 'none';
        }

        const hwaccelSelect = document.getElementById('hwaccelSelect');
        if (hwaccelSelect) {
            hwaccelSelect.value = this.videoSettings.hwaccel;
            hwaccelSelect.addEventListener('change', (e) => {
                this.videoSettings.hwaccel = e.target.value;
                this.showEncoderSpecificSettings(e.target.value);
                this.saveToStorage();
            });
        }

        const fpsSelect = document.getElementById('fpsSelect');
        if (fpsSelect) {
            const curFps = this.videoSettings.fps || 'source';
            fpsSelect.value = String(curFps);

            fpsSelect.addEventListener('change', (e) => {
                this.videoSettings.fps = e.target.value || 'source';
                this.saveToStorage();
            });
        }

        const nvencQuality = document.getElementById('nvencQuality');
        const nvencQualityValue = document.getElementById('nvencQualityValue');
        if (nvencQuality && nvencQualityValue) {
            nvencQuality.value = this.videoSettings.nvencSettings.quality;
            nvencQualityValue.textContent = this.videoSettings.nvencSettings.quality;
            nvencQuality.addEventListener('input', (e) => {
                this.videoSettings.nvencSettings.quality = e.target.value;
                nvencQualityValue.textContent = e.target.value;
                this.saveToStorage();
            });
        }

        const nvencPreset = document.getElementById('nvencPreset');
        if (nvencPreset) {
            nvencPreset.value = this.videoSettings.nvencSettings.preset;
            nvencPreset.addEventListener('change', (e) => {
                this.videoSettings.nvencSettings.preset = e.target.value;
                this.saveToStorage();
            });
        }

        const qsvQuality = document.getElementById('qsvQuality');
        const qsvQualityValue = document.getElementById('qsvQualityValue');
        if (qsvQuality && qsvQualityValue) {
            qsvQuality.value = this.videoSettings.qsvSettings.quality;
            qsvQualityValue.textContent = this.videoSettings.qsvSettings.quality;
            qsvQuality.addEventListener('input', (e) => {
                this.videoSettings.qsvSettings.quality = e.target.value;
                qsvQualityValue.textContent = e.target.value;
                this.saveToStorage();
            });
        }

        const qsvPreset = document.getElementById('qsvPreset');
        if (qsvPreset) {
            qsvPreset.value = this.videoSettings.qsvSettings.preset;
            qsvPreset.addEventListener('change', (e) => {
                this.videoSettings.qsvSettings.preset = e.target.value;
                this.saveToStorage();
            });
        }

        const vaapiDevice = document.getElementById('vaapiDevice');
        if (vaapiDevice) {
            vaapiDevice.value = this.videoSettings.vaapiSettings.device;
            vaapiDevice.addEventListener('input', (e) => {
                this.videoSettings.vaapiSettings.device = e.target.value;
                this.saveToStorage();
            });
        }

        const vaapiQuality = document.getElementById('vaapiQuality');
        const vaapiQualityValue = document.getElementById('vaapiQualityValue');
        if (vaapiQuality && vaapiQualityValue) {
            vaapiQuality.value = this.videoSettings.vaapiSettings.quality;
            vaapiQualityValue.textContent = this.videoSettings.vaapiSettings.quality;
            vaapiQuality.addEventListener('input', (e) => {
                this.videoSettings.vaapiSettings.quality = e.target.value;
                vaapiQualityValue.textContent = e.target.value;
                this.saveToStorage();
            });
        }
    }

    toggleEncoderSettings(show) {
        const encoderGroup = document.getElementById('encoderSettingsGroup');
        const audioTranscodeContainer = document.getElementById('audioTranscodeContainer');
        if (encoderGroup) {
            encoderGroup.style.display = show ? 'block' : 'none';
            if (show) {
                this.showEncoderSpecificSettings(this.videoSettings.hwaccel);
            }
        }

        if (audioTranscodeContainer) {
            audioTranscodeContainer.style.display = show ? 'block' : 'none';
            if (!show) {
                this.videoSettings.audioTranscodeEnabled = false;
                const audioTranscodeCheckbox = document.getElementById('audioTranscodeCheckbox');
                if (audioTranscodeCheckbox) {
                    audioTranscodeCheckbox.checked = false;
                }
                this.toggleAudioCodecSettings(false);
                this.saveToStorage();
            }
        }
    }

    showEncoderSpecificSettings(encoder) {
        document.querySelectorAll('.encoder-specific-settings').forEach(el => {
            el.style.display = 'none';
        });

        const specificSettings = document.getElementById(`${encoder}Settings`);
        if (specificSettings) {
            specificSettings.style.display = 'block';
        }
    }

    updateAudioBitrateOptions(codec) {
        const container = document.getElementById('audioBitrateContainer');
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

        if (options.length > 1) {
            container.innerHTML = `
                <label for="audioBitrateSelect" data-i18n="label.audioBitrate">Ses Bitrate:</label>
                <select id="audioBitrateSelect">
                    ${options.map(bitrate =>
                        `<option value="${bitrate}" ${bitrate === this.videoSettings.audioBitrate ? 'selected' : ''}>
                            ${bitrate === 'lossless' ? 'Lossless' : bitrate === 'original' ? 'Orijinal' : bitrate}
                        </option>`
                    ).join('')}
                </select>
            `;

            const audioBitrateSelect = document.getElementById('audioBitrateSelect');
            if (audioBitrateSelect) {
                audioBitrateSelect.addEventListener('change', (e) => {
                    this.videoSettings.audioBitrate = e.target.value;
                    this.saveToStorage();
                });
            }
        }
    }
    getSettings() {
        return { ...this.videoSettings };
    }
}
