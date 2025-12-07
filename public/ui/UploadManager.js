export class UploadManager {
  constructor(app) {
    this.app = app;
    this.uploadCanceled = false;
    this.currentUploadId = null;

    this.currentXhr = null;
    this.currentChunkAbortController = null;
    this.currentProbeAbortController = null;
  }

  async probeAndShowStreamSelection(file, isLocalFile = false, currentFormat = 'mp4') {
  console.log('🔍 probeAndShowStreamSelection called:', { file, isLocalFile, currentFormat });
    const controller = new AbortController();
    this.currentProbeAbortController = controller;

    try {
      this.app.showNotification(
        this.app.t('upload.analyzingFile') || 'Dosya analiz ediliyor...',
        'info',
        'progress'
      );

      let probeResult;
      let fileName;

            if (isLocalFile) {
        console.log('📁 Starting local file probe:', file);
        fileName = file;
        const response = await fetch('/api/probe/local', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (localStorage.getItem('gharmonize_admin_token') || '')
          },
          body: JSON.stringify({ localPath: file }),
          signal: controller.signal
        });
        console.log('📁 Local probe response status:', response.status);
        probeResult = await response.json();
        console.log('📁 Local probe result:', probeResult);
      } else {
        console.log('📤 Starting upload file probe (chunked):', file.name);
        fileName = file.name;
        probeResult = await this.probeWithChunks(file, currentFormat);
        console.log('📤 Chunked upload probe result:', probeResult);
      }

      this.currentProbeAbortController = null;

      if (!probeResult.success) {
        throw new Error(probeResult.error || 'Dosya analiz edilemedi');
      }

      const streams = probeResult.streams || {};
      const audioStreams = streams.audio || [];
      const subtitleStreams = streams.subtitle || [];
      const videoStreams = streams.video || [];

      const hasVideo = videoStreams.length > 0;
      const hasMultipleAudio = audioStreams.length > 1;

      const audioLanguages = {};
      audioStreams.forEach(s => (audioLanguages[s.index] = s.language || 'und'));

      const subtitleLanguages = {};
      subtitleStreams.forEach(s => (subtitleLanguages[s.index] = s.language || 'und'));

      if (currentFormat !== 'mp4') {
        if (!hasVideo || !hasMultipleAudio) {
          const selectedAudio =
            probeResult.defaultSelection?.audio?.length
              ? probeResult.defaultSelection.audio
              : (audioStreams[0] ? [audioStreams[0].index] : []);

          const baseResult = {
            audio: selectedAudio,
            subtitles: [],
            hasVideo,
            outputContainer: null,
            audioLanguages,
            subtitleLanguages
          };

          if (probeResult.finalPath) {
            baseResult.probedFinalPath = probeResult.finalPath;
          }

          return baseResult;
        }
        console.log('🎬 Video detected + multiple audio tracks → opening AUDIO FORMAT modal...');
      }

      console.log('🎬 Probe successful, opening modal...');
      const result = await this.showStreamSelectionModal(
        streams,
        probeResult.defaultSelection || { audio: [], subtitles: [] },
        currentFormat,
        fileName
      );

      if (!result) {
        if (probeResult.finalPath) {
          try {
            await fetch('/api/probe/cleanup', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ finalPath: probeResult.finalPath })
            });
          } catch (e) {
            console.warn('Probe cleanup failed:', e);
          }
        }
        return null;
      }

      result.audioLanguages = audioLanguages;
      result.subtitleLanguages = subtitleLanguages;
      result.hasVideo = hasVideo;

      if (probeResult.finalPath) {
        result.probedFinalPath = probeResult.finalPath;
      }

      return result;
    } catch (error) {
      this.currentProbeAbortController = null;

      if (error.name === 'AbortError') {
        console.log('🔺 Probe aborted by user');
        return null;
      }

      console.error('❌ Probe error:', error);
      this.app.showNotification(
        `${this.app.t('notif.errorPrefix')}: ${error.message}`,
        'error',
        'error'
      );
      return null;
    }
  }

  async showStreamSelectionModal(streams, defaultSelection, currentFormat = 'mp4', fileName = null) {
    console.log('🎬 Opening stream selection modal...', { streams, defaultSelection, fileName });

    const audioStreams = Array.isArray(streams.audio) ? streams.audio : [];
    const subtitleStreams = Array.isArray(streams.subtitle) ? streams.subtitle : [];
    const videoStreams = Array.isArray(streams.video) ? streams.video : [];

    const safeFileName = fileName
      ? (this.app.escapeHtml?.(fileName) || fileName)
      : '';

    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'custom-modal custom-modal--info';
      modal.innerHTML = `
        <div class="custom-modal__header">
          <div class="custom-modal__icon">🎬</div>
          <div class="custom-modal__content">
            ${fileName ? `
              <h3 class="custom-modal__filename">
                ${safeFileName}
              </h3>
            ` : ''}
            <h4 class="custom-modal__subtitle">
              ${this.app.t('streamSelection.title') || 'Ses ve Altyazı Seçimi'}
            </h4>
            <div class="custom-modal__message">
              ${currentFormat === 'mp4' ? `
              <div class="stream-selection-section">
                <h4>${this.app.t('streamSelection.container') || 'Çıktı Biçimi'}</h4>
                <div class="stream-list">
                  <label class="stream-item">
                    <input type="radio" name="outputContainer" value="mp4" checked>
                    <span class="stream-info">${this.app.t('streamSelection.mp4Default') || 'MP4 (varsayılan)'}</span>
                  </label>
                  <label class="stream-item">
                    <input type="radio" name="outputContainer" value="mkv">
                    <span class="stream-info">${this.app.t('streamSelection.mkvOriginal') || 'MKV (orijinal altyazı codec)'}</span>
                  </label>
                </div>
              </div>
              ` : ''}
              <div class="stream-selection-modal">
                <div class="stream-selection-section">
                  <h4>${this.app.t('streamSelection.audioStreams') || 'Ses Kanalları'}</h4>
                  <div class="stream-list" id="audioStreamsList">
                    ${audioStreams.map(stream => `
                      <label class="stream-item">
                        <input type="checkbox"
                              value="${stream.index}"
                              ${defaultSelection.audio.includes(stream.index) ? 'checked' : ''}
                              class="audio-stream-checkbox">
                        <span class="stream-info">
                          <strong>${(stream.language || 'und').toUpperCase()}</strong> -
                          ${stream.codec_long}
                          ${stream.channels ? `(${this.app.t('streamSelection.channels', {count: stream.channels}) || `${stream.channels} kanal`})` : ''}
                          ${stream.title ? `- ${stream.title}` : ''}
                          ${stream.default ? ` [${this.app.t('streamSelection.default') || 'Varsayılan'}]` : ''}
                        </span>
                      </label>
                    `).join('')}
                  </div>
                </div>
                ${
                  (currentFormat === 'mp4' || currentFormat === 'mkv') && subtitleStreams.length > 0
                    ? `
                <div class="stream-selection-section">
                  <h4>${this.app.t('streamSelection.subtitleStreams') || 'Altyazılar'}</h4>
                  <div class="stream-list" id="subtitleStreamsList">
                    ${subtitleStreams.map(stream => `
                      <label class="stream-item">
                        <input type="checkbox"
                            value="${stream.index}"
                            ${defaultSelection.subtitles.includes(stream.index) ? 'checked' : ''}
                            class="subtitle-stream-checkbox">
                        <span class="stream-info">
                          <strong>${(stream.language || 'und').toUpperCase()}</strong> -
                          ${stream.codec_long}
                          ${stream.title ? `- ${stream.title}` : ''}
                          ${stream.default ? ` [${this.app.t('streamSelection.default') || 'Varsayılan'}]` : ''}
                          ${stream.forced ? ` [${this.app.t('streamSelection.forced') || 'Zorunlu'}]` : ''}
                        </span>
                      </label>
                    `).join('')}
                  </div>
                </div>
                    `
                    : ''
                }

                ${videoStreams.length > 0 ? `
                <div class="stream-selection-section">
                  <h4>${this.app.t('streamSelection.videoInfo') || 'Video Bilgisi'}</h4>
                  <div class="video-info">
                    ${videoStreams.map(video => `
                      <div>${video.codec_long} - ${video.bit_rate ? (video.bit_rate / 1000).toFixed(0) + ' kbps' : ''}</div>
                    `).join('')}
                  </div>
                </div>
                ` : ''}
              </div>
            </div>
          </div>
        </div>
        <div class="custom-modal__footer">
          <button class="modal-btn modal-btn-cancel" type="button">
            ${this.app.t('btn.cancel') || 'İptal'}
          </button>
          <button class="modal-btn modal-btn-confirm" type="button">
            ${this.app.t('btn.confirm') || 'Onayla'}
          </button>
        </div>
      `;

      const backdrop = this.app.modalManager.modalContainer;
      const cleanup = () => {
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal);
        }
        if (backdrop && backdrop.children.length === 0) {
          backdrop.style.display = 'none';
          backdrop.classList.remove('is-open');
        }
        document.removeEventListener('keydown', escHandler);
        backdrop.removeEventListener('click', backdropHandler);
      };

      const resolveAndCleanup = (value) => {
        cleanup();
        resolve(value);
      };

      const confirmHandler = async () => {
        const selectedAudio = Array.from(
          modal.querySelectorAll('.audio-stream-checkbox:checked')
        ).map(cb => parseInt(cb.value, 10));

        const selectedSubtitles = Array.from(
          modal.querySelectorAll('.subtitle-stream-checkbox:checked')
        ).map(cb => parseInt(cb.value, 10));

        const containerEl = modal.querySelector('input[name="outputContainer"]:checked');
        const outputContainer = containerEl ? containerEl.value : null;
        const finalContainer = outputContainer || currentFormat;

        const audioLanguages = {};
        audioStreams.forEach(s => {
          audioLanguages[s.index] = s.language || 'und';
        });

        const subtitleLanguages = {};
        subtitleStreams.forEach(s => {
          subtitleLanguages[s.index] = s.language || 'und';
        });

        let finalSubtitleIndexes = selectedSubtitles;

        if (finalContainer === 'mp4' && selectedSubtitles.length > 0) {
          const subByIndex = new Map(
            subtitleStreams.map(s => [s.index, s])
          );

          const unsupported = [];
          const supported = [];

          const isBitmapSubtitle = (stream) => {
            if (!stream) return false;
            const codec = (stream.codec || stream.codec_name || '').toLowerCase();
            const codecLong = (stream.codec_long || '').toLowerCase();

            if (/hdmv_pgs|pgs|dvd_subtitle|dvb_subtitle|xsub/.test(codec)) return true;
            if (/pgs|dvd subtitle|dvb subtitle|vobsub|bitmap/.test(codecLong)) return true;
            return false;
          };

          for (const idx of selectedSubtitles) {
            const info = subByIndex.get(idx);
            if (isBitmapSubtitle(info)) {
              unsupported.push(info);
            } else {
              supported.push(info);
            }
          }

          if (unsupported.length > 0) {
            const unsupportedList = unsupported
              .map(s => {
                const lang = (s.language || 'und').toUpperCase();
                const codec = s.codec_long || s.codec || '';
                const title = s.title ? ` - ${s.title}` : '';
                return `• ${lang} – ${codec}${title}`;
              })
              .join('\n');

            const warningTitle =
              this.app.t('streamSelection.subtitleMp4WarningTitle') ||
              'MP4 Altyazı Uyumluluğu';

            const warningMessage =
              this.app.t('streamSelection.subtitleMp4WarningMessage', {
                list: unsupportedList
              }) ||
              (
              `MP4 çıkışı bazı altyazı türlerini (özellikle PGS / DVD Subtitle gibi bitmap altyazıları) desteklemez.

              Aşağıdaki altyazılar MP4 dosyasına eklenemeyecek ve devam edersen atlanacaktır:

              ${unsupportedList}

              Devam etmek istemiyorsan çıktı biçimini MKV olarak değiştirip tekrar dene.`
              );

            const confirmed = await this.app.modalManager.showConfirm({
              title: warningTitle,
              message: warningMessage,
              confirmText: this.app.t('btn.continueWithoutSubtitles') || 'Devam (uyumsuzları atla)',
              cancelText: this.app.t('btn.goBack') || 'Geri dön',
              type: 'warning'
            });
            if (!confirmed) {
              console.log('⚠️ User returned at MP4 subtitle warning.');
              return;
            }

            finalSubtitleIndexes = supported.map(s => s.index);
            console.log('🎯 Only compatible subtitles kept for MP4:', finalSubtitleIndexes);
          }
        }

        console.log('🎯 Final selected streams (final):', {
          selectedAudio,
          selectedSubtitles: finalSubtitleIndexes,
          outputContainer,
          audioLanguages,
          subtitleLanguages
        });

        resolveAndCleanup({
          audio: selectedAudio,
          subtitles: finalSubtitleIndexes,
          hasVideo: videoStreams.length > 0,
          outputContainer,
          audioLanguages,
          subtitleLanguages
        });
      };

      const cancelHandler = () => {
        console.log('❌ Closing modal');
        resolveAndCleanup(null);
      };

      const escHandler = (e) => {
        if (e.key === 'Escape') {
          cancelHandler();
        }
      };

      const backdropHandler = (e) => {
        if (e.target === backdrop) {
          cancelHandler();
        }
      };

      modal.querySelector('.modal-btn-confirm').addEventListener('click', confirmHandler);
      modal.querySelector('.modal-btn-cancel').addEventListener('click', cancelHandler);
      document.addEventListener('keydown', escHandler);
      backdrop.addEventListener('click', backdropHandler);

      if (backdrop) {
        backdrop.style.display = 'flex';
        backdrop.classList.add('is-open');
        backdrop.appendChild(modal);
      }

      console.log('✅ Modal shown');
    });
  }

  async handleFileSubmit(e) {
    console.log('🚀 handleFileSubmit called');
    e.preventDefault();

    const fileInput = document.getElementById('fileInput');
    const format = document.getElementById('formatSelect').value;
    const bitrate = document.getElementById('bitrateSelect').value;
    const sampleRate = document.getElementById('sampleRateSelect').value;
    const includeLyrics = document.getElementById('lyricsCheckbox').checked;
    const sourceType = document.querySelector('input[name="fileSourceType"]:checked')?.value || 'upload';

    console.log('📋 Form data:', { format, bitrate, sampleRate, includeLyrics, sourceType });

    const audioOutputFormats = ['mp3','aac','ac3','eac3','ogg','opus','m4a','alac','flac','wav'];
    const isVideoFormat = (format === 'mp4' || format === 'mkv');
    const isAudioFormat = audioOutputFormats.includes(format);
    const shouldProbeForStreams = isVideoFormat || isAudioFormat;

    if (sourceType === 'local') {
            console.log('🏠 Starting local file processing');
            const checked = Array.from(document.querySelectorAll('input[name="localFileItem"]:checked'));
            console.log('✅ Selected local files:', checked.map(cb => cb.value));

            if (!checked.length) {
                this.app.showNotification(
                    this.app.t('notif.pickLocalFile') || 'Lütfen sunucudaki en az bir dosyayı seçin',
                    'error',
                    'error'
                );
                return;
            }

            const localNames = checked.map(cb => cb.value);

            for (const fileName of localNames) {
                console.log('🔄 Processing file:', fileName);
                let streamSelection = null;
                let effectiveFormat = format;

                if (shouldProbeForStreams) {
                    console.log('🎬 Calling stream selection (video/audio output)...');
                    const currentFormat = format;
                    streamSelection = await this.probeAndShowStreamSelection(
                      fileName,
                      true,
                      currentFormat
                    );
                    console.log('📊 Stream selection result:', streamSelection);

                    if (streamSelection === null) {
                        console.log('❌ User cancelled the modal');
                        continue;
                    }

                    effectiveFormat =
                      streamSelection.outputContainer && format === 'mp4'
                        ? streamSelection.outputContainer
                        : format;
                }

                const payload = {
                  format: effectiveFormat,
                  bitrate,
                  sampleRate,
                  includeLyrics,
                  localPath: fileName,
                  volumeGain: this.app.currentVolumeGain
                };

                if (streamSelection) {
                payload.selectedStreams = {
                  audio: streamSelection.audio,
                  subtitles: streamSelection.subtitles,
                  hasVideo: streamSelection.hasVideo,
                  volumeGain: this.app.currentVolumeGain,
                  audioLanguages: streamSelection.audioLanguages,
                  subtitleLanguages: streamSelection.subtitleLanguages
                };
          }

                console.log('📦 Payload to be sent:', payload);

                if (localNames.length === 1) {
                    console.log('📤 Submitting single-file job');
                    await this.app.jobManager.submitJob(payload, false);
                } else {
                    const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
                    console.log('📦 Creating batch job:', batchId);
                    this.app.jobManager.ensureBatch(batchId, localNames.length, {
                        format,
                        bitrate,
                        source: this.app.t('ui.serverFiles') || 'Server files'
                    });

                    await this.app.jobManager.submitJob(
                        { ...payload, clientBatch: batchId },
                        false
                    );
                }
            }
            return;
        }

    if (!fileInput.files.length) {
      this.app.showNotification(this.app.t('notif.pickFile'), 'error', 'error');
      return;
    }

    const files = Array.from(fileInput.files);
    this.uploadCanceled = false;

    console.log('📤 Upload files:', files.map(f => f.name));

    const maxSize = Math.max(...files.map(f => f.size));
    if (maxSize > 10 * 1024 * 1024 * 1024) {
      const sizeInGB = (maxSize / (1024 * 1024 * 1024)).toFixed(1);

      const confirmed = await this.app.modalManager.showConfirm({
        title: this.app.t('upload.largeFileTitle') || 'Büyük Dosya Uyarısı',
        message: this.app.t('upload.largeFileWarning', {
          size: sizeInGB
        }) || `Seçilen dosyalardan en az biri çok büyük (${sizeInGB}GB). Yükleme işlemi uzun sürebilir ve bellek kullanımı yüksek olabilir. Devam etmek istiyor musunuz?`,
        confirmText: this.app.t('btn.continue') || 'Devam Et',
        cancelText: this.app.t('btn.cancel') || 'İptal',
        type: 'warning'
      });

      if (!confirmed) {
        return;
      }
    }

    let uploadBatchId = null;
    if (files.length > 1) {
      uploadBatchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      this.app.jobManager.ensureBatch(uploadBatchId, files.length, {
        format,
        bitrate,
        source: this.app.t('ui.upload') || 'Upload'
      });
    }

    this.currentUploadId = null;
    this.createUploadProgressBar();
    this.updateUploadProgress(0);

        try {
      for (const file of files) {
        if (this.uploadCanceled) {
          console.log('📝 Upload cancelled by user (flag before loop)');
          break;
        }

        const ONE_GB = 10 * 1024 * 1024 * 1024;
        const USE_CHUNKED_UPLOAD = file.size > ONE_GB;

        if (USE_CHUNKED_UPLOAD) {
          const sizeInGB = (file.size / (1024 * 1024 * 1024)).toFixed(2);
          this.app.showNotification(
            this.app.t('upload.largeFileUploading', { size: sizeInGB }) ||
            `Büyük dosya yükleniyor (${sizeInGB}GB)... 32MB parçalar halinde yükleniyor.`,
            'info',
            'progress'
          );

          if (shouldProbeForStreams) {
            console.log('🎬 Chunked upload + stream selection...', file.name);
            const currentFormat = format;
            const streamSelection = await this.probeAndShowStreamSelection(file, false, currentFormat);
            console.log('📊 Upload stream selection result:', streamSelection);

            if (streamSelection === null) {
              console.log('❌ User cancelled the modal');
              continue;
            }

            const effectiveFormat =
              streamSelection.outputContainer && format === 'mp4'
                ? streamSelection.outputContainer
                : format;

            const payload = {
              format: effectiveFormat,
              bitrate,
              sampleRate,
              includeLyrics,
              volumeGain: this.app.currentVolumeGain,
              selectedStreams: {
                audio: streamSelection.audio,
                subtitles: streamSelection.subtitles,
                hasVideo: streamSelection.hasVideo,
                audioLanguages: streamSelection.audioLanguages,
                subtitleLanguages: streamSelection.subtitleLanguages
              }
            };

            if (uploadBatchId) {
              payload.clientBatch = uploadBatchId;
            }
            if (streamSelection.probedFinalPath) {
              await this.submitJobForExistingFile(streamSelection.probedFinalPath, payload);
            } else {
              await this.submitLargeFileWithChunks(file, payload, false);
            }
          } else {
            const payload = {
              format,
              bitrate,
              sampleRate,
              includeLyrics,
              volumeGain: this.app.currentVolumeGain
            };
            if (uploadBatchId) {
              payload.clientBatch = uploadBatchId;
            }
            await this.submitLargeFileWithChunks(file, payload, false);
          }
        } else {
          if (shouldProbeForStreams) {
            console.log('🎬 Normal upload + stream selection...', file.name);
            const currentFormat = format;
            const streamSelection = await this.probeAndShowStreamSelection(file, false, currentFormat);
            console.log('📊 Upload stream selection result:', streamSelection);

            if (streamSelection === null) {
              console.log('❌ User cancelled the modal');
              continue;
            }

            const effectiveFormat =
              streamSelection.outputContainer && format === 'mp4'
                ? streamSelection.outputContainer
                : format;

            const payload = {
              format: effectiveFormat,
              bitrate,
              sampleRate,
              includeLyrics,
              volumeGain: this.app.currentVolumeGain,
              selectedStreams: {
                audio: streamSelection.audio,
                subtitles: streamSelection.subtitles,
                hasVideo: streamSelection.hasVideo,
                audioLanguages: streamSelection.audioLanguages,
                subtitleLanguages: streamSelection.subtitleLanguages
              }
            };

            if (uploadBatchId) {
              payload.clientBatch = uploadBatchId;
            }

            if (streamSelection.probedFinalPath) {
              await this.submitJobForExistingFile(streamSelection.probedFinalPath, payload);
            } else {
              const formData = new FormData();
              formData.append('file', file);
              formData.append('format', effectiveFormat);
              formData.append('bitrate', bitrate);
              formData.append('volumeGain', this.app.currentVolumeGain);
              formData.append('sampleRate', sampleRate);
              formData.append('includeLyrics', includeLyrics);
              formData.append('selectedStreams', JSON.stringify(payload.selectedStreams));

              if (uploadBatchId) {
                formData.append('clientBatch', uploadBatchId);
              }

              await this.submitJobWithProgress(formData, true);
            }
          } else {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('format', format);
            formData.append('bitrate', bitrate);
            formData.append('sampleRate', sampleRate);
            formData.append('includeLyrics', includeLyrics);

            if (uploadBatchId) {
              formData.append('clientBatch', uploadBatchId);
            }

            await this.submitJobWithProgress(formData, true);
          }
        }
      }
    } catch (error) {
      console.error('❌ Upload error:', error);
      if (!this.uploadCanceled) {
        this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
      }
    } finally {
      if (!this.uploadCanceled) {
        document.getElementById('fileForm').reset();
        document.getElementById('lyricsCheckbox').checked = false;
      }
      setTimeout(() => this.resetUploadProgress(), 5000);
      this.currentUploadId = null;
      this.resetCancelButton();
    }
  }

  async submitJobForExistingFile(finalPath, payload) {
    console.log('📨 submitJobForExistingFile:', finalPath, payload);

    const jobPayload = {
      ...payload,
      finalUploadPath: finalPath
    };

    return this.submitJobWithProgress(jobPayload, false);
  }

  async submitLargeFileWithChunks(file, payload, isFormData = false) {
    console.log('📦 submitLargeFileWithChunks called:', file.name, payload);
    const CHUNK_SIZE = 32 * 1024 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let uploadedChunks = 0;
    const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.currentUploadId = uploadId;

    const controller = new AbortController();
    this.currentChunkAbortController = controller;

    this.createUploadProgressBar();
    this.updateUploadProgress(0);

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (this.uploadCanceled) {
          console.log('📝 Upload cancelled by user (chunk loop)');
          return;
        }

        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const chunkFormData = new FormData();
        chunkFormData.append('chunk', chunk);
        chunkFormData.append('chunkIndex', chunkIndex);
        chunkFormData.append('totalChunks', totalChunks);
        chunkFormData.append('uploadId', uploadId);
        chunkFormData.append('originalName', file.name);
        chunkFormData.append('format', payload.format);
        chunkFormData.append('bitrate', payload.bitrate);
        chunkFormData.append('sampleRate', payload.sampleRate);
        chunkFormData.append('includeLyrics', payload.includeLyrics);
        if (payload.selectedStreams) {
          chunkFormData.append('selectedStreams', JSON.stringify(payload.selectedStreams));
        }
        if (payload.volumeGain != null) {
          chunkFormData.append('volumeGain', payload.volumeGain);
        }

        const response = await fetch('/api/upload/chunk', {
          method: 'POST',
          body: chunkFormData,
          signal: controller.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Chunk ${chunkIndex + 1} upload failed`);
        }

        const result = await response.json();
        uploadedChunks++;

        const progress = (uploadedChunks / totalChunks) * 100;
        this.updateUploadProgress(progress);

        if (result.finalPath) {
          console.log('🎉 All chunks completed, creating job...');
          this.updateUploadProgress(100);
          return await this.app.jobManager.submitJob({
            ...payload,
            finalUploadPath: result.finalPath
          }, false);
        }
      }
    } catch (error) {
      if (!this.uploadCanceled) {
        console.error('❌ Chunked upload error:', error);
        this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        throw error;
      } else {
        console.log('🛑 Chunked upload aborted by user');
      }
    } finally {
      this.currentUploadId = null;
      this.currentChunkAbortController = null;
    }
  }

    async probeWithChunks(file, currentFormat = 'mp4') {
    console.log('📦 probeWithChunks called:', file.name);

    const CHUNK_SIZE = 32 * 1024 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let uploadedChunks = 0;
    const uploadId = `probe_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.currentUploadId = uploadId;

    const controller = new AbortController();
    this.currentChunkAbortController = controller;
    this.createUploadProgressBar();
    this.updateUploadProgress(0);

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (this.uploadCanceled) {
          console.log('📝 Probe cancelled by user (chunk loop)');
          return null;
        }

        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const chunkFormData = new FormData();
        chunkFormData.append('chunk', chunk);
        chunkFormData.append('chunkIndex', chunkIndex);
        chunkFormData.append('totalChunks', totalChunks);
        chunkFormData.append('uploadId', uploadId);
        chunkFormData.append('originalName', file.name);
        chunkFormData.append('purpose', 'probe');

        const response = await fetch('/api/upload/chunk', {
          method: 'POST',
          body: chunkFormData,
          signal: controller.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Probe chunk ${chunkIndex + 1} upload failed`);
        }

        const result = await response.json();
        uploadedChunks++;

        const progress = (uploadedChunks / totalChunks) * 100;
        this.updateUploadProgress(progress);
        if (result.success && result.streams && result.defaultSelection) {
          console.log('🎯 Probe (chunk) result:', result);
          this.updateUploadProgress(100);
          return result;
        }
      }

      return null;
    } catch (error) {
      if (this.uploadCanceled || error.name === 'AbortError') {
        console.log('🛑 Probe chunk upload aborted by user');
        return null;
      }

      console.error('❌ Probe chunk upload error:', error);
      this.app.showNotification(
        `${this.app.t('notif.errorPrefix')}: ${error.message}`,
        'error',
        'error'
      );
      throw error;
    } finally {
      this.currentUploadId = null;
      this.currentChunkAbortController = null;
    }
  }

  cancelUpload() {
    console.log('❌ Cancelling upload');
    this.uploadCanceled = true;

    const cancelBtn = document.getElementById('cancelUploadBtn');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.textContent = this.app.t('btn.canceling') || 'İptal Ediliyor...';
    }

    if (this.currentXhr) {
      try {
        this.currentXhr.abort();
      } catch (e) {
        console.warn('XHR abort failed:', e);
      }
    }
    if (this.currentChunkAbortController) {
      try {
        this.currentChunkAbortController.abort();
      } catch (e) {
        console.warn('Chunk abort failed:', e);
      }
    }
    if (this.currentProbeAbortController) {
      try {
        this.currentProbeAbortController.abort();
      } catch (e) {
        console.warn('Probe abort failed:', e);
      }
    }

    const uploadId = this.currentUploadId;

    if (uploadId) {
      fetch('/api/upload/chunk/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId })
      })
        .then(response => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.json();
        })
        .then(data => {
          this.app.showNotification(
            this.app.t('upload.canceledWithCleanup', { count: data.cleanedCount }) ||
            `Upload iptal edildi, ${data.cleanedCount} dosya temizlendi`,
            'info',
            'action'
          );
        })
        .catch(error => {
          console.warn('Upload cancel error:', error);
          this.app.showNotification(
            this.app.t('upload.canceledWithError') ||
            'Upload iptal edildi (temizleme hatası)',
            'warning',
            'action'
          );
        })
        .finally(() => {
          this.resetUploadProgress();
          this.resetCancelButton();
          this.currentUploadId = null;
        });
    } else {
      this.app.showNotification(
        this.app.t('upload.canceled') || 'Upload iptal edildi',
        'info',
        'action'
      );
      this.resetUploadProgress();
      this.resetCancelButton();
    }
  }

  resetCancelButton() {
    const cancelBtn = document.getElementById('cancelUploadBtn');
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = this.app.t('btn.cancelUpload') || 'İptal Et';
    }
  }

  createUploadProgressBar() {
    console.log('📊 Creating progress bar');
    const fileForm = document.getElementById('fileForm');
    if (!fileForm) return;
    let progressContainer = document.getElementById('uploadProgressContainer');
    if (!progressContainer) {
      progressContainer = document.createElement('div');
      progressContainer.id = 'uploadProgressContainer';
      progressContainer.className = 'upload-progress-container';
      progressContainer.style.display = 'none';
      progressContainer.innerHTML = `
        <div class="upload-progress-bar">
          <div class="upload-progress-fill" id="uploadProgressFill"></div>
        </div>
        <div class="upload-progress-text" id="uploadProgressText">0%</div>
        <div class="upload-actions" style="margin-top: 10px; text-align: center;">
          <button type="button" id="cancelUploadBtn" class="btn-danger" style="padding: 4px 12px; font-size: 12px;">
            ${this.app.t('btn.cancelUpload') || 'İptal Et'}
          </button>
        </div>
      `;

      fileForm.appendChild(progressContainer);
      const cancelBtn = document.getElementById('cancelUploadBtn');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          this.cancelUpload();
        });
        this.resetCancelButton();
      }
    } else {
      this.resetCancelButton();
    }
  }

  resetUploadProgress() {
    console.log('📊 Resetting progress bar');
    const container = document.getElementById('uploadProgressContainer');
    const fill = document.getElementById('uploadProgressFill');
    const text = document.getElementById('uploadProgressText');

    if (container) container.style.display = 'none';
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '0%';
  }

  updateUploadProgress(percentage) {
    const container = document.getElementById('uploadProgressContainer');
    const fill = document.getElementById('uploadProgressFill');
    const text = document.getElementById('uploadProgressText');

    if (!container || !fill || !text) {
      this.createUploadProgressBar();
      return this.updateUploadProgress(percentage);
    }

    container.style.display = 'block';
    fill.style.width = `${percentage}%`;
    text.textContent = `${Math.round(percentage)}%`;
  }

  async submitJobWithProgress(payload, isFormData = false) {
    console.log('🚀 submitJobWithProgress called:', { payload, isFormData });

    try {
      console.log('📦 Sent payload:', payload);

      let effectiveFormat;
      if (isFormData && payload instanceof FormData) {
        effectiveFormat = payload.get('format') || document.getElementById('formatSelect').value;
      } else {
        effectiveFormat = payload.format || document.getElementById('formatSelect').value;
      }

      if ((effectiveFormat === 'mp4' || effectiveFormat === 'mkv') &&
        this.app.videoManager.videoSettings.transcodeEnabled) {
        console.log('🎬 Adding video settings to payload:', this.app.videoManager.videoSettings);
        if (!isFormData) {
          payload.videoSettings = this.app.videoManager.videoSettings;
        } else {
          payload.append('videoSettings', JSON.stringify(this.app.videoManager.videoSettings));
        }
      } else {
        console.log('🎬 Video transcode disabled or format is not video');
      }

      if (effectiveFormat === 'eac3' || effectiveFormat === 'ac3' || effectiveFormat === 'aac') {
        const stereoConvert = document.getElementById('stereoConvertSelect')?.value || 'auto';
        const atempoAdjust = document.getElementById('atempoSelect')?.value || 'none';

        if (!isFormData) {
          payload.stereoConvert = stereoConvert;
          payload.atempoAdjust = atempoAdjust;
        } else {
          payload.append('stereoConvert', stereoConvert);
          payload.append('atempoAdjust', atempoAdjust);
        }
      }

      if (effectiveFormat === 'flac' || effectiveFormat === 'wav') {
        const bitDepth = document.getElementById('bitDepthSelect')?.value || '16';
        if (!isFormData) {
          payload.bitDepth = bitDepth;
        } else {
          payload.append('bitDepth', bitDepth);
        }
      }

      if (effectiveFormat === 'flac') {
        const compEl = document.getElementById('compressionLevelRange');
        const compVal = compEl ? compEl.value : '5';
        if (!isFormData) payload.compressionLevel = compVal;
        else payload.append('compressionLevel', compVal);
      }

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        this.currentXhr = xhr;

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && e.total > 0) {
            const percentComplete = (e.loaded / e.total) * 100;
            this.updateUploadProgress(percentComplete);
          }
        });

        xhr.addEventListener('load', () => {
          console.log('📨 Job response received:', xhr.status);
          this.currentXhr = null;

          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const result = JSON.parse(xhr.responseText);
              console.log('✅ Job created:', result);

              if (result.clientBatch) {
                this.app.jobManager.jobToBatch.set(result.id, result.clientBatch);
                this.app.jobManager.ensureBatch(result.clientBatch, result.batchTotal, {
                  format: result.format,
                  bitrate: result.bitrate,
                  source: result.source
                });
                this.app.jobManager.trackJob(result.id, result.clientBatch);
              } else {
                const empty = document.getElementById('job-empty');
                if (empty) empty.remove();
                this.app.jobManager.trackJob(result.id);
              }

              this.app.showNotification(this.app.t('notif.queue'), 'success', 'queue');
              resolve(result);
            } catch (error) {
              console.error('❌ Job response parse error:', error);
              reject(error);
            }
          } else {
            console.error('❌ Job response error status:', xhr.status);
            if (xhr.status === 413 && isFormData && payload instanceof FormData) {
              try {
                const file = payload.get('file');
                if (file && file.size != null) {
                  console.warn('Received 413, enabling chunk upload fallback…');
                  const format =
                    payload.get('format') ||
                    document.getElementById('formatSelect')?.value;
                  const volumeGainRaw = payload.get('volumeGain');
                  const volumeGain =
                    volumeGainRaw === null || volumeGainRaw === undefined
                      ? null
                      : Number(volumeGainRaw);
                  const bitrate =
                    payload.get('bitrate') ||
                    document.getElementById('bitrateSelect')?.value;
                  const sampleRate =
                    payload.get('sampleRate') ||
                    document.getElementById('sampleRateSelect')?.value ||
                    48000;

                  const includeLyricsRaw = payload.get('includeLyrics');
                  const includeLyrics =
                    includeLyricsRaw === true ||
                    includeLyricsRaw === 'true' ||
                    includeLyricsRaw === '1';

                  const clientBatch = payload.get('clientBatch') || null;

                  const selectedStreamsRaw = payload.get('selectedStreams');
                  let selectedStreams = null;
                  try {
                    selectedStreams = selectedStreamsRaw ? JSON.parse(selectedStreamsRaw) : null;
                  } catch {}

                  const fallbackPayload = {
                    format,
                    bitrate,
                    sampleRate,
                    includeLyrics,
                    selectedStreams,
                    volumeGain
                  };
                  if (clientBatch) {
                    fallbackPayload.clientBatch = clientBatch;
                  }
                  this.submitLargeFileWithChunks(file, fallbackPayload, false)
                    .then(resolve)
                    .catch(reject);
                  return;
                }
              } catch (e) {
                console.warn('413 fallback setup error:', e);
              }
            }
            try {
              const e = JSON.parse(xhr.responseText);
              const msg = e?.error?.code
                ? this.app.t(`errors.${e.error.code}`)
                : (e?.error?.message || 'error');
              reject(new Error(msg));
            } catch {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          }
        });

        xhr.addEventListener('error', () => {
          console.error('❌ Network error');
          this.currentXhr = null;
          reject(new Error('Network error'));
        });

        xhr.addEventListener('abort', () => {
          console.log('🛑 XHR aborted by user');
          this.currentXhr = null;
          reject(new Error('Upload aborted'));
        });

        xhr.open('POST', '/api/jobs');
        console.log('📤 Submitting job...');

        if (!isFormData) {
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.send(JSON.stringify(payload));
        } else {
          xhr.send(payload);
        }
      });
    } catch (error) {
      console.error('❌ Job submission error:', error);
      this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
      throw error;
    }
  }
}
