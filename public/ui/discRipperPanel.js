let currentDiscInfo = null;
let selectedTitleIndexes = new Set();
let isScanning = false;
let isRipping = false;
let ripCancelled = false;
let discModalOpened = false;
let selectedAudioTracksByTitle = new Map();
let selectedSubtitleTracksByTitle = new Map();

let currentProgress = {
  current: 0,
  total: 0,
  currentTitle: null,
  isActive: false
};

const API_BASE = '';

// Handles t in the browser UI layer.
function t(key, vars = {}) {
  if (window.i18n && typeof window.i18n.t === 'function') {
    return window.i18n.t(key, vars);
  }
  let str = key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return str;
}

// Handles log disc metadata in the browser UI layer.
function logDisc(message) {
  const el = document.getElementById('discLog');
  if (!el) return;
  const ts = new Date().toLocaleTimeString();

  let text;
  if (message && typeof message === 'object' && message.__i18n) {
    text = t(message.key, message.vars || {});
  }
  else if (typeof message === 'string' && message.startsWith('disc.')) {
    text = t(message);
  }
  else {
    text = message;
  }

  el.textContent += `[${ts}] ${text}\n`;
  el.scrollTop = el.scrollHeight;
}


// Handles ensure disc metadata modal open in the browser UI layer.
function ensureDiscModalOpen() {
  if (!window.modalManager) {
    return;
  }
  if (discModalOpened) {
    return;
  }

  const panel = document.getElementById('discRipperAdvancedPanel');
  if (!panel) return;
  if (window.i18n?.apply) {
    window.i18n.apply(panel);
  }

  discModalOpened = true;
  panel.style.display = 'block';
  window.modalManager
    .showCustomNode({
      title: t('disc.section.header') || 'Disc Ripper',
      node: panel,
      type: 'info',
      closeText: t('disc.modal.close') || 'Kapat'
    })
    .then(() => {
      panel.style.display = 'none';
      discModalOpened = false;
    })
    .catch(() => {
      panel.style.display = 'none';
      discModalOpened = false;
    });
}

// Renders audio streams in the browser UI layer.
function renderAudioStreams(title, listIndex) {
  const container = document.createElement('div');
  container.className = 'disc-stream-group collapsed';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'disc-stream-header';

  const headerLabel = document.createElement('span');
  headerLabel.setAttribute('data-i18n', 'disc.streams.audioLabel');
  headerLabel.textContent = t('disc.streams.audioLabel') || 'Ses Parçaları';

  const headerArrow = document.createElement('span');
  headerArrow.className = 'disc-stream-arrow';
  headerArrow.textContent = '▾';

  header.appendChild(headerLabel);
  header.appendChild(headerArrow);
  container.appendChild(header);

  const body = document.createElement('div');
  body.className = 'disc-stream-body';
  container.appendChild(body);
  header.addEventListener('click', () => {
    container.classList.toggle('collapsed');
  });

  const audioTracks = Array.isArray(title.audioTracks) ? title.audioTracks : [];
  if (audioTracks.length === 0) {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.setAttribute('data-i18n', 'disc.streams.noAudio');
  empty.textContent = t('disc.streams.noAudio') || 'Ses parçası yok';
  body.appendChild(empty);
  return container;
}

  if (!selectedAudioTracksByTitle.has(listIndex)) {
    const set = new Set();
    const defaults = audioTracks.filter(t => t.isDefault || t.default);
    if (defaults.length > 0) {
      defaults.forEach(t => set.add(t.index));
    } else {
      set.add(audioTracks[0].index);
    }
    selectedAudioTracksByTitle.set(listIndex, set);
  }
  const selected = selectedAudioTracksByTitle.get(listIndex);

  audioTracks.forEach(track => {
    const trackIndex = track.index;
    const lang = track.language || track.lang || 'und';
    const codec = track.codec || '';
    const channels = track.channels || track.ch || '';
    const flags = [
      track.default || track.isDefault ? (t('disc.streams.defaultFlag') || 'varsayılan') : '',
      track.forced ? (t('disc.streams.forcedFlag') || 'zorunlu') : ''
    ].filter(Boolean).join(' • ');

    const label = document.createElement('label');
    label.className = 'disc-stream-chip';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(trackIndex);
    cb.dataset.trackType = 'audio';
    cb.dataset.titleIndex = String(listIndex);
    cb.dataset.trackIndex = String(trackIndex);

    cb.addEventListener('change', () => {
      const set = selectedAudioTracksByTitle.get(listIndex) || new Set();
      if (cb.checked) {
        set.add(trackIndex);
        logDisc(
          t('disc.streams.audioSelected', {
            index: trackIndex,
            lang,
            codec: codec || 'unknown',
            channels: channels || '?'
          }) || `Ses parçası seçildi [${trackIndex}] (${lang}, ${codec}, ${channels})`
        );
      } else {
        set.delete(trackIndex);
        logDisc(
          t('disc.streams.audioDeselected', {
            index: trackIndex,
            lang,
            codec: codec || 'unknown',
            channels: channels || '?'
          }) || `Ses parçası kaldırıldı [${trackIndex}] (${lang}, ${codec}, ${channels})`
        );
      }
      selectedAudioTracksByTitle.set(listIndex, set);
    });

    const span = document.createElement('span');
    span.textContent = [
      `#${trackIndex}`,
      lang,
      codec,
      channels ? `${channels}ch` : '',
      flags
    ].filter(Boolean).join(' • ');

    label.appendChild(cb);
    label.appendChild(span);
    body.appendChild(label);
  });

  return container;
}

// Renders subtitle streams in the browser UI layer.
function renderSubtitleStreams(title, listIndex) {
  const container = document.createElement('div');
  container.className = 'disc-stream-group collapsed';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'disc-stream-header';

  const headerLabel = document.createElement('span');
  headerLabel.setAttribute('data-i18n', 'disc.streams.subtitleLabel');
  headerLabel.textContent = t('disc.streams.subtitleLabel') || 'Altyazı Parçaları';

  const headerArrow = document.createElement('span');
  headerArrow.className = 'disc-stream-arrow';
  headerArrow.textContent = '▾';

  header.appendChild(headerLabel);
  header.appendChild(headerArrow);
  container.appendChild(header);

  const body = document.createElement('div');
  body.className = 'disc-stream-body';
  container.appendChild(body);

  header.addEventListener('click', () => {
    container.classList.toggle('collapsed');
  });

  const subTracks = Array.isArray(title.subtitleTracks) ? title.subtitleTracks : [];
  if (subTracks.length === 0) {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.setAttribute('data-i18n', 'disc.streams.noSubtitle');
  empty.textContent = t('disc.streams.noSubtitle') || 'Altyazı parçası yok';
  body.appendChild(empty);
  return container;
}

  if (!selectedSubtitleTracksByTitle.has(listIndex)) {
    const set = new Set();
    const defaults = subTracks.filter(t => t.isDefault || t.default || t.forced);
    defaults.forEach(t => set.add(t.index));
    selectedSubtitleTracksByTitle.set(listIndex, set);
  }
  const selected = selectedSubtitleTracksByTitle.get(listIndex);

  subTracks.forEach(track => {
    const trackIndex = track.index;
    const lang = track.language || track.lang || 'und';
    const codec = track.codec || '';
    const flags = [
      track.default || track.isDefault ? (t('disc.streams.defaultFlag') || 'varsayılan') : '',
      track.forced ? (t('disc.streams.forcedFlag') || 'zorunlu') : ''
    ].filter(Boolean).join(' • ');

    const label = document.createElement('label');
    label.className = 'disc-stream-chip';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(trackIndex);
    cb.dataset.trackType = 'subtitle';
    cb.dataset.titleIndex = String(listIndex);
    cb.dataset.trackIndex = String(trackIndex);

    cb.addEventListener('change', () => {
      const set = selectedSubtitleTracksByTitle.get(listIndex) || new Set();
      if (cb.checked) {
        set.add(trackIndex);
        logDisc(
          t('disc.streams.subtitleSelected', {
            index: trackIndex,
            lang,
            codec: codec || 'unknown'
          }) || `Altyazı parçası seçildi [${trackIndex}] (${lang}, ${codec})`
        );
      } else {
        set.delete(trackIndex);
        logDisc(
          t('disc.streams.subtitleDeselected', {
            index: trackIndex,
            lang,
            codec: codec || 'unknown'
          }) || `Altyazı parçası kaldırıldı [${trackIndex}] (${lang}, ${codec})`
        );
      }
      selectedSubtitleTracksByTitle.set(listIndex, set);
    });

    const span = document.createElement('span');
    span.textContent = [
      `#${trackIndex}`,
      lang,
      codec,
      flags
    ].filter(Boolean).join(' • ');

    label.appendChild(cb);
    label.appendChild(span);
    body.appendChild(label);
  });

  return container;
}

// Formats duration display for the browser UI layer.
function formatDurationDisplay(raw) {
  if (raw == null) return '-';

  if (typeof raw === 'string') {
    if (/^\d+:\d{2}(:\d{2})?$/.test(raw)) return raw;
    const asNum = Number(raw);
    if (!Number.isNaN(asNum)) return formatDurationFromSeconds(asNum);
    return raw;
  }

  if (typeof raw === 'number') {
    return formatDurationFromSeconds(raw);
  }

  return String(raw);
}

// Formats duration from seconds for the browser UI layer.
function formatDurationFromSeconds(sec) {
  if (!Number.isFinite(sec)) return '-';
  sec = Math.max(0, Math.round(sec));

  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Formats size gi b for the browser UI layer.
function formatSizeGiB(bytes) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib < 0.01) return '<0.01 GB';
  return gib.toFixed(2) + ' GB';
}


// Shows disc metadata modal in the browser UI layer.
function showDiscModal(type, title, message, onConfirm = null, onCancel = null) {
  if (window.modalManager && (modalManager.showAlert || modalManager.showConfirm)) {
    if (type === 'confirm') {
      if (typeof modalManager.showConfirm === 'function') {
        modalManager.showConfirm({
            title,
            message,
            type: 'disc',
            confirmText: t('disc.modal.confirmYes') || 'Evet',
            cancelText: t('disc.modal.confirmNo') || 'Hayır'
          }).then((confirmed) => {
          if (confirmed) {
            onConfirm && onConfirm();
          } else {
            onCancel && onCancel();
          }
        });
        return;
      }
    }
    const typeMap = {
      info: 'disc',
      warning: 'warning',
      error: 'danger',
      success: 'success'
    };
    const alertType = typeMap[type] || 'disc';

    if (typeof modalManager.showAlert === 'function') {
      modalManager.showAlert({
        title,
        message,
        type: alertType,
        buttonText: t('disc.modal.ok') || 'Tamam'
      }).then(() => {
        onConfirm && onConfirm();
      });
      return;
    }
  }

  if (type === 'confirm') {
    if (confirm(title + '\n\n' + message)) {
      onConfirm && onConfirm();
    } else {
      onCancel && onCancel();
    }
  } else {
    alert(title + '\n\n' + message);
    onConfirm && onConfirm();
  }
}

// Initializes disc metadata progress stream payload for the browser UI layer.
function initDiscProgressStream() {
  try {
    const es = new EventSource(`${API_BASE}/api/disc/stream`);

    es.onmessage = (ev) => {
      if (!ev.data) return;
      try {
        const data = JSON.parse(ev.data);
        handleProgressUpdate(data);
      } catch (e) {
        console.error('disc progress parse error:', e);
      }
    };

    es.onerror = (err) => {
      console.warn('disc progress stream error:', err);
    };
  } catch (e) {
    console.error('disc progress stream init error:', e);
  }
}

// Handles reset progress in the browser UI layer.
function resetProgress() {
  currentProgress = {
    current: 0,
    total: 0,
    currentTitle: null,
    isActive: false
  };
  updateProgressUI(0, 0, t('disc.progress.ready') || 'Hazır');
}

// Handles start progress in the browser UI layer.
function startProgress(total, firstTitleIndex = null) {
  currentProgress = {
    current: 0,
    total,
    currentTitle: firstTitleIndex,
    isActive: true
  };
  updateProgressUI(0, total, t('disc.progress.starting') || 'Başlatılıyor...');
}

// Updates progress UI state for the browser UI layer.
function updateProgressUI(percent, total, text = '') {
  const fill = document.getElementById('discProgressFill');
  const overlay = document.getElementById('discProgressOverlay');
  const txt = document.getElementById('discProgressText');

  const safe = Math.max(0, Math.min(100, Math.round(percent || 0)));

  if (fill) {
    fill.style.width = `${safe}%`;
    fill.style.transition = 'width 0.3s ease';
  }

  if (overlay) {
    overlay.textContent = safe + '%';
  }

  if (txt) {
    if (text) {
      txt.textContent = text;
    } else if (total > 0) {
      txt.textContent = t('disc.progress.status', {
        current: currentProgress.current,
        total,
        percent: safe
      }) || `${currentProgress.current}/${total} • ${safe}%`;
    } else {
      txt.textContent = t('disc.progress.ready') || 'Hazır';
    }
  }
}

// Handles handle progress update in the browser UI layer.
function handleProgressUpdate(data) {
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'scan_log': {
      if (data.i18n) {
        logDisc({ __i18n: true, key: data.key, vars: data.vars || {} });
      } else {
        logDisc(data.message || '');
      }
      break;
    }

    case 'title_start': {
      const idx = data.titleIndex ?? '?';
      const name = data.outputFile || `Title ${idx}`;
      logDisc(
        t('disc.log.titleProcessing', { index: idx, name }) ||
        `Title ${idx} işleniyor: ${name}`
      );
      updateProgressUI(0, currentProgress.total || 1, data.message || '');
      break;
    }

    case 'progress': {
      const p = typeof data.percent === 'number' ? data.percent : 0;
      let msg = '';
      if (data.__i18n && data.key) {
        msg = t(data.key, data.vars || {});
      } else {
        msg = data.message || '';
      }
      updateProgressUI(p, currentProgress.total || 1, msg);
      break;
    }

    case 'title_complete': {
      currentProgress.current++;
      const total = currentProgress.total || 1;
      const overall = Math.round((currentProgress.current / total) * 100);

      const idx = data.titleIndex ?? '?';
      const name = data.outputFile || `Title ${idx}`;
      logDisc(
        t('disc.log.titleCompleted', { index: idx, name }) ||
        `Title ${idx} tamamlandı: ${name}`
      );

      updateProgressUI(overall, total, data.message || '');
      break;
    }

    case 'title_error': {
      const idx = data.titleIndex ?? '?';
      logDisc(
        t('disc.log.titleError', {
          index: idx,
          message: data.message || 'Bilinmeyen hata'
        }) ||
        `Title ${idx} hatası: ${data.message || 'Bilinmeyen hata'}`
      );
      break;
    }

    case 'rip_cancelled': {
      logDisc(t('disc.log.ripCancelled') || 'Ripleme iptal edildi.');
      resetProgress();
      isRipping = false;
      break;
    }

    default:
      break;
  }
}

// Handles choose disc source folder in the browser UI layer.
async function chooseDiscSourceFolder() {
  const input = document.getElementById('discSourcePath');
  if (!input) return;

  if (!window.electronAPI || typeof window.electronAPI.selectDirectory !== 'function') {
    showDiscModal(
      'info',
      t('disc.alert.folderPickerUnavailable.title') || 'Bilgi',
      t('disc.alert.folderPickerUnavailable.message') ||
        'Klasör seçici yalnızca masaüstü uygulamada kullanılabilir.'
    );
    return;
  }

  try {
    const selected = await window.electronAPI.selectDirectory(input.value.trim());
    if (selected?.canceled) return;
    if (!selected?.path) {
      throw new Error(selected?.error || 'No path selected');
    }

    input.value = selected.path;
    logDisc(
      t('disc.log.sourceSelected', { path: selected.path }) ||
        `Disk kaynağı seçildi: ${selected.path}`
    );
  } catch (e) {
    showDiscModal(
      'error',
      t('disc.alert.folderPickerError.title') || 'Klasör Seçme Hatası',
      t('disc.alert.folderPickerError.message', { message: e.message }) ||
        `Klasör seçilirken hata oluştu: ${e.message}`
    );
  }
}


// Handles scan progress disc metadata in the browser UI layer.
async function scanDisc() {
  const input = document.getElementById('discSourcePath');
  if (!input) return;

  const sourcePath = input.value.trim();
  if (!sourcePath) {
    showDiscModal(
      'warning',
      t('disc.alert.sourcePathRequired.title') || 'Uyarı',
      t('disc.alert.sourcePathRequired.message') || 'Lütfen disk kaynağını girin.'
    );
    return;
  }

  if (isScanning) return;
  isScanning = true;

  const cancelBtn = document.getElementById('discCancelScanBtn');
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  logDisc(
    t('disc.log.scanningDisc', { path: sourcePath }) ||
    `Disk taranıyor: ${sourcePath}`
  );

  try {
    const res = await fetch(`${API_BASE}/api/disc/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || 'Scan failed');
    }

    currentDiscInfo = data || {};
    selectedTitleIndexes.clear();

    displayTitles(currentDiscInfo.titles || []);

    const titlesSection = document.getElementById('discTitlesSection');
    const actionsSection = document.getElementById('discActionsSection');
    const progressSection = document.getElementById('discProgressSection');

    if (titlesSection) titlesSection.style.display = 'block';
    if (actionsSection) actionsSection.style.display = 'flex';
    if (progressSection) progressSection.style.display = 'flex';

    logDisc(
      t('disc.log.scanCompleted', {
        count: (data.titles || []).length,
        type: data.type || 'Disc'
      }) ||
      `Tarama tamamlandı: ${(data.titles || []).length} title bulundu (${data.type || 'Disc'})`
    );
  } catch (e) {
    if (e.message === 'Scan cancelled') {
      logDisc(t('disc.log.scanCancelled') || 'Tarama iptal edildi.');
    } else {
      logDisc(
        t('disc.log.scanError', { message: e.message }) ||
        `Tarama hatası: ${e.message}`
      );
      showDiscModal(
        'error',
        t('disc.alert.scanError.title') || 'Tarama Hatası',
        t('disc.alert.scanError.message', { message: e.message }) ||
          `Tarama sırasında hata oluştu: ${e.message}`
      );
    }
  } finally {
    isScanning = false;
    const cancelBtn2 = document.getElementById('discCancelScanBtn');
    if (cancelBtn2) cancelBtn2.style.display = 'none';
  }
}

// Cancels scan progress in the browser UI layer.
async function cancelScan() {
  if (!isScanning) return;
  try {
    await fetch(`${API_BASE}/api/disc/cancel-scan`, { method: 'POST' });
    logDisc(t('disc.log.scanCancelled') || 'Tarama iptal edildi.');
  } catch (e) {
    console.error('disc cancelScan error:', e);
  }
}

// Builds title stats line for the browser UI layer.
function buildTitleStatsLine(title, listIndex) {
  const realIndex = title.index ?? (listIndex + 1);
  const duration = formatDurationDisplay(title.duration);
  const chapters = Array.isArray(title.chapters) ? title.chapters.length : 0;
  const audioCount = Array.isArray(title.audioTracks) ? title.audioTracks.length : 0;
  const subCount = Array.isArray(title.subtitleTracks) ? title.subtitleTracks.length : 0;

  const sizeText = formatSizeGiB(title.sizeBytes || title.estimatedSizeBytes || 0);
  const sizeLabel = sizeText
    ? (t('disc.title.sizeLabel', { size: sizeText }) || `Boyut: ${sizeText}`)
    : null;

  const statsPieces = [
    t('disc.title.indexLabel', { index: realIndex }) || `Index: ${realIndex}`,
    t('disc.title.durationLabel', { duration }) || `Süre: ${duration}`,
    t('disc.title.audioCountLabel', { count: audioCount }) || `Ses: ${audioCount}`,
    t('disc.title.subtitleCountLabel', { count: subCount }) || `Altyazı: ${subCount}`,
    t('disc.title.chapterCountLabel', { count: chapters }) || `Chapter: ${chapters}`
  ];

  if (sizeLabel) {
    statsPieces.push(sizeLabel);
  }

  return statsPieces.join(' • ');
}

// Handles display titles in the browser UI layer.
function displayTitles(titles) {
  const listEl = document.getElementById('discTitlesList');
  const sectionEl = document.getElementById('discTitlesSection');
  const countBadge = document.getElementById('discTitlesCount');

  if (!listEl || !sectionEl) return;
  if (countBadge) {
    const titleCount = titles && titles.length > 0 ? titles.length : 0;
    countBadge.textContent = titleCount;
  }

  const header = sectionEl.querySelector('.collapsible-header');
  if (header && !header.hasAttribute('data-listener-added')) {
    header.setAttribute('data-listener-added', 'true');
    header.addEventListener('click', () => {
      sectionEl.classList.toggle('collapsed');
    });
  }

  listEl.innerHTML = '';
  listEl.className = 'titles-container';

  selectedAudioTracksByTitle = new Map();
  selectedSubtitleTracksByTitle = new Map();
  const hasTitles = titles && titles.length > 0;

  if (!hasTitles) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.setAttribute('data-i18n', 'disc.titles.empty');
    empty.textContent = t('disc.titles.empty') || 'Herhangi bir title bulunamadı.';
    listEl.appendChild(empty);
    sectionEl.classList.add('collapsed');
    return;
  }

  sectionEl.classList.remove('collapsed');

  titles.forEach((title, listIndex) => {
    const realIndex = title.index ?? (listIndex + 1);
    const statsLine = buildTitleStatsLine(title, listIndex);

    const item = document.createElement('div');
    item.className = 'title-item';

    const checkboxId = `disc-title-${listIndex}`;

    item.innerHTML = `
      <div class="title-header">
        <input
          type="checkbox"
          id="${checkboxId}"
          class="disc-title-checkbox"
          data-list-index="${listIndex}"
        >
        <div class="title-meta">
          <strong>${title.discTitle || title.name || `Title ${realIndex}`}</strong>
          <div class="title-stats" data-title-index="${listIndex}">
            <small class="title-stats-line">${statsLine}</small>
            ${title.playlistFile ? `<small class="title-playlist">Playlist: ${title.playlistFile}</small>` : ''}
          </div>
        </div>
      </div>
    `;

    const streamsWrapper = document.createElement('div');
    streamsWrapper.className = 'title-streams-wrapper';
    streamsWrapper.appendChild(renderAudioStreams(title, listIndex));
    streamsWrapper.appendChild(renderSubtitleStreams(title, listIndex));
    item.appendChild(streamsWrapper);

    const checkbox = item.querySelector('.disc-title-checkbox');
    checkbox.addEventListener('change', () => {
      onTitleSelectChange(listIndex, checkbox.checked, title);
    });

    listEl.appendChild(item);
  });

  updateRipButtonState();
}


// Handles on title select change in the browser UI layer.
function onTitleSelectChange(listIndex, isChecked, title) {
  if (!currentDiscInfo || !currentDiscInfo.titles) return;

  const name = title.discTitle || title.name || `Title ${title.index ?? listIndex + 1}`;

  if (isChecked) {
    selectedTitleIndexes.add(listIndex);
    logDisc(
      t('disc.log.titleSelected', {
        index: title.index ?? listIndex + 1,
        name
      }) || `Seçildi: ${name}`
    );
  } else {
    selectedTitleIndexes.delete(listIndex);
    logDisc(
      t('disc.log.titleDeselected', {
        index: title.index ?? listIndex + 1,
        name
      }) || `Seçim kaldırıldı: ${name}`
    );
  }

  const items = document.querySelectorAll('#discTitlesList .title-item');
  const item = items[listIndex];
  if (item) {
    if (isChecked) item.classList.add('selected');
    else item.classList.remove('selected');
  }

  updateRipButtonState();
}

// Updates rip progress button state for the browser UI layer.
function updateRipButtonState() {
  const btn = document.getElementById('discRipBtn');
  if (!btn) return;
  btn.disabled = selectedTitleIndexes.size === 0 || !currentDiscInfo;
}

// Cancels rip progress in the browser UI layer.
async function cancelRip() {
  if (!isRipping) return;

  const title =
    t('disc.modal.cancelRip.title') || 'Ripleme İptal Edilsin mi?';
  const message =
    t('disc.modal.cancelRip.message') ||
    'Devam eden ripleme işlemi iptal edilecek. Bu işlem geri alınamaz.\n\nİptal etmek istediğinizden emin misiniz?';

  showDiscModal(
    'confirm',
    title,
    message,
    () => performRipCancel(),
    () => {
      logDisc(
        t('disc.log.ripCancelAborted') ||
        'Ripleme iptali kullanıcı tarafından iptal edildi.'
      );
    }
  );
}

// Handles perform rip progress cancel in the browser UI layer.
async function performRipCancel() {
  if (!isRipping) return;

  ripCancelled = true;

  try {
    await fetch(`${API_BASE}/api/disc/cancel-rip`, { method: 'POST' });
    logDisc(t('disc.log.ripCancelled') || 'Ripleme iptal edildi.');
  } catch (e) {
    console.error('disc cancelRip error:', e);
    showDiscModal(
      'error',
      t('disc.alert.cancelRipError.title') || 'İptal Hatası',
      t('disc.alert.cancelRipError.message', { message: e.message }) ||
        `İptal sırasında hata oluştu: ${e.message}`
    );
  }
}

// Handles rip progress selected in the browser UI layer.
async function ripSelected() {
  if (!currentDiscInfo || !Array.isArray(currentDiscInfo.titles)) {
    showDiscModal(
      'warning',
      t('disc.alert.scanFirst.title') || 'Uyarı',
      t('disc.alert.scanFirst.message') || 'Lütfen önce diski tarayın.'
    );
    return;
  }

  if (selectedTitleIndexes.size === 0) {
    showDiscModal(
      'warning',
      t('disc.alert.selectAtLeastOneTitle.title') || 'Uyarı',
      t('disc.alert.selectAtLeastOneTitle.message') || 'Lütfen en az bir title seçin.'
    );
    return;
  }

   if (isRipping) return;

  const titlesToRip = Array.from(selectedTitleIndexes)
    .map(i => ({
      listIndex: i,
      title: currentDiscInfo.titles[i]
    }))
    .filter(x => x.title);

  const titlesForMessage = titlesToRip
    .map(({ title }) => `• ${title.discTitle || title.name || `Title ${title.index ?? '?'}`}`)
    .join('\n');

  showDiscModal(
    'confirm',
    t('disc.modal.ripConfirmation.title') || 'Dönüştürme Başlatılsın mı?',
    t('disc.modal.ripConfirmation.message', {
      count: titlesToRip.length,
      titles: titlesForMessage
    }) ||
      `${titlesToRip.length} title dönüştürülecek:\n\n${titlesForMessage}`,
    () => startRipProcess(titlesToRip)
  );
}

// Handles start rip progress process in the browser UI layer.
async function startRipProcess(titlesToRip) {
  if (!currentDiscInfo) return;

  isRipping = true;
  ripCancelled = false;

  const discType = currentDiscInfo.type || 'DVD';

  startProgress(titlesToRip.length, titlesToRip[0]?.title?.index);

  const cancelBtn = document.getElementById('discCancelRipBtn');
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  logDisc(
    t('disc.log.ripAllStarted', {
      count: titlesToRip.length
    }) ||
      `${titlesToRip.length} title için ripleme başlatıldı.`
  );

  for (const { title, listIndex } of titlesToRip) {
    if (ripCancelled) {
      logDisc(
        t('disc.log.ripLoopStopped') ||
        'Ripleme döngüsü iptal nedeniyle durduruldu.'
      );
      break;
    }

    const index = title.index ?? '?';
    const name = title.discTitle || title.name || `Title ${index}`;

    const audioSet = selectedAudioTracksByTitle.get(listIndex) || new Set();
    const subSet = selectedSubtitleTracksByTitle.get(listIndex) || new Set();

    const audioTracks = Array.from(audioSet);
    const subtitleTracks = Array.from(subSet);

    logDisc(
      t('disc.log.ripTitleStarted', {
        index,
        name
      }) || `Ripleme başlatıldı: ${name}`
    );
    const streamsKey = 'disc.log.selectedStreams';
    const translated = t(streamsKey, {
      audio: audioTracks.length ? audioTracks.join(', ') : '-',
      subs: subtitleTracks.length ? subtitleTracks.join(', ') : '-'
    });

    const fallbackText = `Seçili ses: [${audioTracks.join(', ')}], seçili altyazı: [${subtitleTracks.join(', ')}]`;

    const finalText =
      translated && translated !== streamsKey ? translated : fallbackText;

    logDisc(finalText);

    try {
      const res = await fetch(`${API_BASE}/api/disc/rip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath: currentDiscInfo.source,
          titleIndex: title.index,
          options: {
            discType,
            playlistFile: title.playlistFile || null,
            audioTracks,
            subtitleTracks
          },
          titleInfo: {
            ...title,
            sourceType: discType,
            sourcePath: currentDiscInfo.source
          }
        })
      });

      const result = await res.json();

      if (res.status === 499 || result?.error === 'Rip cancelled') {
        logDisc(
          t('disc.log.ripCancelled') ||
          'Ripleme iptal edildi.'
        );
        break;
      }

      if (!res.ok) {
        throw new Error(result?.error || `Rip failed (HTTP ${res.status})`);
      }

      logDisc(
        t('disc.log.ripCompleted', {
          path: result.downloadPath || '(indirilebilir dosya)'
        }) ||
          `Ripleme tamamlandı. İndirme yolu: ${result.downloadPath || '(bilinmiyor)'}`
      );

      if (result.metadata) {
        logDisc(
          t('disc.log.metadataWritten', {
            path: (result.downloadPath || '').replace(/\.mkv$/, '.json')
          }) ||
            'Metadata yazıldı.'
        );
      }
    } catch (e) {
      logDisc(
        t('disc.log.ripError', {
          index: title.index ?? '?',
          name,
          message: e.message
        }) ||
          `Ripleme hatası (${name}): ${e.message}`
      );
    }
  }

  if (!ripCancelled) {
    updateProgressUI(100, titlesToRip.length, t('disc.progress.allCompleted') || 'Tüm işler tamamlandı.');
    showDiscModal(
      'info',
      t('disc.alert.allDone.title') || 'Tamamlandı',
      t('disc.alert.allDone.message') || 'Tüm seçili title\'lar başarıyla işlendi.'
    );
  }

  isRipping = false;
  resetProgress();

  const cancelBtn2 = document.getElementById('discCancelRipBtn');
  if (cancelBtn2) cancelBtn2.style.display = 'none';
}

// Initializes disc metadata ripper panel for the browser UI layer.
export function initDiscRipperPanel() {
  const sourceInput = document.getElementById('discSourcePath');
  const browseSourceBtn = document.getElementById('discBrowseSourceBtn');
  const scanBtn = document.getElementById('discScanBtn');
  const cancelScanBtn = document.getElementById('discCancelScanBtn');
  const ripBtn = document.getElementById('discRipBtn');
  const cancelRipBtn = document.getElementById('discCancelRipBtn');
  const openBtn = document.getElementById('discRipperOpenBtn');
  const titlesSection = document.getElementById('discTitlesSection');
  const titlesHeader = document.getElementById('discTitlesHeader');
  if (titlesSection) {
    titlesSection.classList.add('collapsed');
  }

  if (titlesHeader) {
    titlesHeader.addEventListener('click', () => {
      titlesSection.classList.toggle('collapsed');
    });
  }

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      ensureDiscModalOpen();
    });
  }

  if (browseSourceBtn) {
    browseSourceBtn.addEventListener('click', () => {
      chooseDiscSourceFolder();
    });
  }

  if (!sourceInput || !scanBtn) {
    return;
  }

  if (scanBtn) {
    scanBtn.addEventListener('click', () => {
      scanDisc();
    });
  }

  if (cancelScanBtn) {
    cancelScanBtn.addEventListener('click', () => cancelScan());
  }

  if (ripBtn) {
    ripBtn.addEventListener('click', () => ripSelected());
  }

  if (cancelRipBtn) {
    cancelRipBtn.addEventListener('click', () => cancelRip());
  }

  resetProgress();
  initDiscProgressStream();

  logDisc(
    t('disc.log.panelReady') ||
    'Disc Ripper paneli hazır.'
  );

  if (window.i18n?.apply) {
    document.addEventListener('i18n:applied', () => {
      const panel = document.getElementById('discRipperAdvancedPanel');
      if (panel) {
        window.i18n.apply(panel);
        if (currentDiscInfo && Array.isArray(currentDiscInfo.titles)) {
          panel.querySelectorAll('.title-stats').forEach(el => {
            const idxStr = el.getAttribute('data-title-index');
            const idx = idxStr != null ? Number(idxStr) : NaN;
            if (Number.isNaN(idx)) return;

            const title = currentDiscInfo.titles[idx];
            if (!title) return;

            const lineEl = el.querySelector('.title-stats-line');
            if (!lineEl) return;

            lineEl.textContent = buildTitleStatsLine(title, idx);
          });
        }
      }
    });
  }
}
