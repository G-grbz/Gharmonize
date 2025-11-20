export class UploadManager {
    constructor(app) {
        this.app = app;
        this.uploadCanceled = false;
        this.currentUploadId = null;
    }

    async handleFileSubmit(e) {
        e.preventDefault();
        const fileInput = document.getElementById('fileInput');
        const format = document.getElementById('formatSelect').value;
        const bitrate = document.getElementById('bitrateSelect').value;
        const sampleRate = document.getElementById('sampleRateSelect').value;
        const includeLyrics = document.getElementById('lyricsCheckbox').checked;
        const sourceType = document.querySelector('input[name="fileSourceType"]:checked')?.value || 'upload';
        if (sourceType === 'local') {
        const checked = Array.from(document.querySelectorAll('input[name="localFileItem"]:checked'));
        if (!checked.length) {
        this.app.showNotification(
            this.app.t('notif.pickLocalFile') || 'Lütfen sunucudaki en az bir dosyayı seçin',
            'error',
            'error'
        );
        return;
    }

    const localNames = checked.map(cb => cb.value);

    const basePayload = {
        format,
        bitrate,
        sampleRate,
        includeLyrics
    };

    if (localNames.length === 1) {
        await this.app.jobManager.submitJob(
            { ...basePayload, localPath: localNames[0] },
            false
        );
    } else {
        const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        this.app.jobManager.ensureBatch(batchId, localNames.length, {
            format,
            bitrate,
            source: this.app.t('ui.serverFiles') || 'Server files'
        });

        for (const name of localNames) {
            await this.app.jobManager.submitJob(
                { ...basePayload, localPath: name, clientBatch: batchId },
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

const maxSize = Math.max(...files.map(f => f.size));
if (maxSize > 25 * 1024 * 1024 * 1024) {
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
            console.log('📝 Upload kullanıcı tarafından iptal edildi (çoklu yükleme)');
            break;
        }

        const USE_CHUNKED_UPLOAD = file.size > 25 * 1024 * 1024 * 1024;

        if (USE_CHUNKED_UPLOAD) {
            const sizeInGB = (file.size / (1024 * 1024 * 1024)).toFixed(2);
            this.app.showNotification(
                this.app.t('upload.largeFileUploading', { size: sizeInGB }) ||
                `Büyük dosya yükleniyor (${sizeInGB}GB)... 32MB parçalar halinde yükleniyor.`,
                'info',
                'progress'
            );

            const payload = {
                format,
                bitrate,
                sampleRate,
                includeLyrics
            };

            if (uploadBatchId) {
                payload.clientBatch = uploadBatchId;
            }

        await this.submitLargeFileWithChunks(file, payload, true);
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
        } catch (error) {
            console.error('Upload hatası:', error);
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

    async submitLargeFileWithChunks(file, payload, isFormData = false) {
        const CHUNK_SIZE = 32 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        let uploadedChunks = 0;
        const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.currentUploadId = uploadId;

        this.createUploadProgressBar();
        this.updateUploadProgress(0);

        try {
            for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                if (this.uploadCanceled) {
                    console.log('📝 Upload kullanıcı tarafından iptal edildi');
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

                const response = await fetch('/api/upload/chunk', {
                    method: 'POST',
                    body: chunkFormData
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.error || `Chunk ${chunkIndex + 1} yükleme başarısız`);
                }

                const result = await response.json();
                uploadedChunks++;

                const progress = (uploadedChunks / totalChunks) * 100;
                this.updateUploadProgress(progress);

                if (result.finalPath) {
                    console.log('🎉 Tüm chunklar tamamlandı, job oluşturuluyor...');
                    return await this.app.jobManager.submitJob({
                        ...payload,
                        finalUploadPath: result.finalPath
                    }, false);
                }
            }

        } catch (error) {
        if (!this.uploadCanceled) {
            console.error('Chunked upload hatası:', error);
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
            throw error;
            }
        } finally {
            this.currentUploadId = null;
        }
    }

    cancelUpload() {
        this.uploadCanceled = true;
        this.resetUploadProgress();
        const cancelBtn = document.getElementById('cancelUploadBtn');
        if (cancelBtn) {
            cancelBtn.disabled = true;
            cancelBtn.textContent = this.app.t('btn.canceling') || 'İptal Ediliyor...';
        }

        if (this.currentUploadId) {
            fetch('/api/upload/chunk/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId: this.currentUploadId })
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
                setTimeout(() => this.resetCancelButton(), 1000);
            })
            .catch(error => {
                this.app.showNotification(
                    this.app.t('upload.canceledWithError') ||
                    'Upload iptal edildi (temizleme hatası)',
                    'warning',
                    'action'
                );
                setTimeout(() => this.resetCancelButton(), 1000);
            });
        } else {
            this.app.showNotification(
                this.app.t('upload.canceled') || 'Upload iptal edildi',
                'info',
                'action'
            );
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
        try {
            console.log("Gönderilen payload:", payload);

            const format = document.getElementById('formatSelect').value;

            if (format === 'mp4' && this.app.videoManager.videoSettings.transcodeEnabled) {
                console.log("🎬 Video ayarları payload'a ekleniyor:", this.app.videoManager.videoSettings);
                if (!isFormData) {
                    payload.videoSettings = this.app.videoManager.videoSettings;
                } else {
                    payload.append('videoSettings', JSON.stringify(this.app.videoManager.videoSettings));
                }
            } else {
                console.log("🎬 Video transcode pasif veya format mp4 değil");
            }

            if (format === 'eac3' || format === 'ac3' || format === 'aac') {
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

            if (format === 'flac' || format === 'wav') {
                const bitDepth = document.getElementById('bitDepthSelect')?.value || '16';
                if (!isFormData) {
                    payload.bitDepth = bitDepth;
                } else {
                    payload.append('bitDepth', bitDepth);
                }
            }

            if (format === 'flac') {
                const compEl = document.getElementById('compressionLevelRange');
                const compVal = compEl ? compEl.value : '5';
                if (!isFormData) payload.compressionLevel = compVal;
                else payload.append('compressionLevel', compVal);
            }

            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percentComplete = (e.loaded / e.total) * 100;
                        this.updateUploadProgress(percentComplete);
                    }
                });

                xhr.addEventListener('load', () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            const result = JSON.parse(xhr.responseText);
                            console.log("Job oluşturuldu:", result);

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
                            reject(error);
                        }
                    } else {
                if (xhr.status === 413 && isFormData && payload instanceof FormData) {
                    try {
                    const file = payload.get('file');
                        if (file && file.size != null) {
                        console.warn('413 alındı, chunk upload fallback devreye giriyor…');
                    const format =
                        payload.get('format') ||
                        document.getElementById('formatSelect')?.value;
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

                    const fallbackPayload = {
                        format,
                        bitrate,
                        sampleRate,
                        includeLyrics
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
                console.warn('413 fallback kurulum hatası:', e);
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
            reject(new Error('Network error'));
        });

        xhr.open('POST', '/api/jobs');

        if (!isFormData) {
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(payload));
                } else {
                    xhr.send(payload);
                }
            });

        } catch (error) {
            console.error("Job gönderme hatası:", error);
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
            throw error;
        }
    }
}
