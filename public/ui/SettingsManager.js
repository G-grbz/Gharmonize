import { modalManager } from './ModalManager.js';

export class SettingsManager {
    // Initializes class state and defaults for the browser UI layer.
    constructor() {
        this.tokenKey = "gharmonize_admin_token";
        this.modal = null;
        this.isInitialized = false;
        this.loginOnly = false;
    }

    // Initializes startup state for the browser UI layer.
    async initialize() {
        if (this.isInitialized) return;

        this.createModal();
        this.setupEventListeners();
        this.isInitialized = true;
    }

    // Creates modal for the browser UI layer.
    createModal() {
        if (document.getElementById('settingsModal')) return;

        const modal = document.createElement('div');
        modal.id = 'settingsModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;z-index:20;';
        modal.innerHTML = this.getModalHTML();
        document.body.appendChild(modal);
        if (window.i18n?.apply) window.i18n.apply(modal);
        this.modal = modal;
    }

    // Returns modal html used for the browser UI layer.
    getModalHTML() {
        return `
            <div class="settings-dialog">
                <div class="settings-dialog__header">
                    <h3 data-i18n="settings.title">Ayarlar</h3>
                    <button id="settingsClose" class="btn-outline">✖</button>
                </div>
                <div id="settingsBody" class="settings-dialog__body">
                    ${this.getLoginViewHTML()}
                    ${this.getFormViewHTML()}
                </div>
            </div>
        `;
    }

    // Returns login view html used for the browser UI layer.
    getLoginViewHTML() {
        return `
            <div id="loginView">
                <form id="loginForm" autocomplete="off">
                <div hidden>
                        <label
                            for="adminUserLogin"
                            class="settings-field-label"
                        >Admin Kullanıcı Adı</label>
                        <input id="adminUserLogin" type="text" name="username" autocomplete="username" value="admin" />
                    </div>
                    <label for="adminPass" class="settings-field-label" data-i18n="settings.adminPassword">Yönetici Şifresi</label>
                    <input id="adminPass" type="password" class="settings-input" autocomplete="current-password" autofocus />
                    <div id="adminError" class="settings-error" aria-live="polite" style="display:none"></div>
                    <div class="settings-actions settings-actions--end">
                        <button id="loginBtn" type="button" class="btn-primary" data-i18n="btn.login">Giriş yap</button>
                    </div>
                </form>
            </div>
        `;
    }

    // Shows notification in the browser UI layer.
    showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    if (window.app?.showNotification) {
        window.app.showNotification(message, type);
        return;
    }

    this.showSimpleToast(message, type);
}

    // Handles tt in the browser UI layer.
    tt(key, fallback = '') {
      const v = this.t(key);
      if (!v || v === key) return fallback || v;
      return v;
    }

    // Shows simple toast in the browser UI layer.
    showSimpleToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'info' ? 'var(--accent)' :
                     type === 'success' ? 'var(--success)' :
                     type === 'error' ? 'var(--error)' : 'var(--accent)'};
        color: white;
        padding: 12px 16px;
        border-radius: 8px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: slideInRight 0.3s ease;
    `;
    toast.textContent = message;

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOutRight 0.3s ease';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, 3000);
}

    // Handles refresh i18n in the browser UI layer.
    refreshI18n() {
      if (!this.modal) return;
      if (window.i18n?.apply) window.i18n.apply(this.modal);
      const toggleBtn = document.getElementById('toggleWidgetKeyBtn');
      if (toggleBtn) {
        const txt = this.t('settings.homepageWidgetKey.toggleTitle');
        toggleBtn.title = txt;
        toggleBtn.setAttribute('aria-label', txt);
      }
      const copyBtn = document.getElementById('copyWidgetKeyBtn');
      if (copyBtn) {
        const txt = this.t('settings.homepageWidgetKey.copyTitle');
        copyBtn.title = txt;
        copyBtn.setAttribute('aria-label', txt);
      }
    }

    // Returns form view html used for the browser UI layer.
    getFormViewHTML() {
    return `
        <div id="formView" style="display:none">
        <div class="settings-tabs">
            <div class="settings-tabs__bar" role="tablist" aria-label="${this.t('settings.tabs.ariaLabel')}">
            <button class="settings-tab" role="tab" aria-selected="false" data-tab="tab-system" data-i18n="settings.tabs.system"></button>
            <button class="settings-tab" role="tab" aria-selected="false" data-tab="tab-spotify" data-i18n="settings.tabs.spotify"></button>
            <button class="settings-tab" role="tab" aria-selected="false" data-tab="tab-youtube" data-i18n="settings.tabs.youtube"></button>
            <button class="settings-tab" role="tab" aria-selected="false" data-tab="tab-widget" data-i18n="settings.tabs.widgetKey"></button>
            <button class="settings-tab is-active" role="tab" aria-selected="true" data-tab="tab-updates" data-i18n="settings.tabs.updates"></button>
            <button class="settings-tab" role="tab" aria-selected="false" data-tab="tab-password" data-i18n="settings.tabs.password"></button>
            </div>

            <div class="settings-tabs__panels">
            <section class="settings-panel" id="tab-system" role="tabpanel">
                <div class="form-group">
                <label for="f_UPLOAD_MAX_BYTES" class="settings-field-label">UPLOAD_MAX_BYTES</label>
                <div class="settings-field-hint muted" data-i18n="settings.maxUpload"></div>
                <input id="f_UPLOAD_MAX_BYTES" type="text" placeholder="" data-i18n-ph="ph.maxUpload">
                </div>

                <div class="form-group">
                <label for="f_YTDLP_BIN" class="settings-field-label">YTDLP_BIN</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytdlpBin"></div>
                <input id="f_YTDLP_BIN" type="text" placeholder="'C:/tools/yt-dlp.exe'" data-i18n-ph="ph.ytdlpBin">
                </div>

                <div class="form-group">
                <label for="f_FFMPEG_BIN" class="settings-field-label">FFMPEG_BIN</label>
                <div class="settings-field-hint muted" data-i18n="settings.ffmpegBin"></div>
                <input id="f_FFMPEG_BIN" type="text" placeholder="" data-i18n-ph="ph.ffmpegBin">
                </div>

                <div class="form-group">
                <label for="f_MEDIA_COMMENT" class="settings-field-label">MEDIA_COMMENT</label>
                <div class="settings-field-hint muted" data-i18n="settings.mediaComment"></div>
                <input id="f_MEDIA_COMMENT" type="text" placeholder="Gharmonize" data-i18n-ph="ph.mediaComment">
                </div>

                <div class="form-group">
                <label for="f_TITLE_CLEAN_PIPE" class="settings-field-label">TITLE_CLEAN_PIPE</label>
                <div class="settings-field-hint muted" data-i18n="settings.titleCleanPipe"></div>
                <select id="f_TITLE_CLEAN_PIPE">
                    <option value="1">1</option>
                    <option value="0">0</option>
                </select>
                </div>

                <div class="form-group">
                <label for="f_CLEAN_SUFFIXES" class="settings-field-label">CLEAN_SUFFIXES</label>
                <div class="settings-field-hint muted" data-i18n="settings.cSuffixes"></div>
                <input id="f_CLEAN_SUFFIXES" type="text" placeholder="''" data-i18n-ph="ph.cSuffixes">
                </div>

                <div class="form-group">
                <label for="f_CLEAN_PHRASES" class="settings-field-label">CLEAN_PHRASES</label>
                <div class="settings-field-hint muted" data-i18n="settings.cPhrases"></div>
                <input id="f_CLEAN_PHRASES" type="text" placeholder="''" data-i18n-ph="ph.cPhrases">
                </div>

                <div class="form-group">
                <label for="f_CLEAN_PARENS" class="settings-field-label">CLEAN_PARENS</label>
                <div class="settings-field-hint muted" data-i18n="settings.cParens"></div>
                <input id="f_CLEAN_PARENS" type="text" placeholder="''" data-i18n-ph="ph.cParens">
                </div>

                <div class="form-group">
                <label for="f_PREVIEW_MAX_ENTRIES" class="settings-field-label">PREVIEW_MAX_ENTRIES</label>
                <div class="settings-field-hint muted" data-i18n="settings.previewMaxEntries">Önizleme/otomix için maksimum parça sayısı</div>
                <input id="f_PREVIEW_MAX_ENTRIES" type="number" min="1" placeholder="50" data-i18n-ph="ph.previewMaxEntries">
                </div>

                <div class="form-group">
                <label for="f_AUTOMIX_ALL_TIMEOUT_MS" class="settings-field-label">AUTOMIX_ALL_TIMEOUT_MS</label>
                <div class="settings-field-hint muted" data-i18n="settings.automixAllTimeout">Otomatik karışım tüm isteği için timeout (ms)</div>
                <input id="f_AUTOMIX_ALL_TIMEOUT_MS" type="number" min="1000" placeholder="30000" data-i18n-ph="ph.automixAllTimeout">
                </div>

                <div class="form-group">
                <label for="f_AUTOMIX_PAGE_TIMEOUT_MS" class="settings-field-label">AUTOMIX_PAGE_TIMEOUT_MS</label>
                <div class="settings-field-hint muted" data-i18n="settings.automixPageTimeout">Otomatik karışım sayfası için timeout (ms)</div>
                <input id="f_AUTOMIX_PAGE_TIMEOUT_MS" type="number" min="1000" placeholder="15000" data-i18n-ph="ph.automixPageTimeout">
                </div>

                <div class="form-group">
                <label for="f_PLAYLIST_ALL_TIMEOUT_MS" class="settings-field-label">PLAYLIST_ALL_TIMEOUT_MS</label>
                <div class="settings-field-hint muted" data-i18n="settings.playlistAllTimeout">Playlist tüm isteği için timeout (ms)</div>
                <input id="f_PLAYLIST_ALL_TIMEOUT_MS" type="number" min="1000" placeholder="45000" data-i18n-ph="ph.playlistAllTimeout">
                </div>

                <div class="form-group">
                <label for="f_PLAYLIST_PAGE_TIMEOUT_MS" class="settings-field-label">PLAYLIST_PAGE_TIMEOUT_MS</label>
                <div class="settings-field-hint muted" data-i18n="settings.playlistPageTimeout">Playlist sayfası için timeout (ms)</div>
                <input id="f_PLAYLIST_PAGE_TIMEOUT_MS" type="number" min="1000" placeholder="15000" data-i18n-ph="ph.playlistPageTimeout">
                </div>

                <div class="form-group">
                <label for="f_PLAYLIST_META_TIMEOUT_MS" class="settings-field-label">PLAYLIST_META_TIMEOUT_MS</label>
                <div class="settings-field-hint muted" data-i18n="settings.playlistMetaTimeout">Playlist metadata için timeout (ms)</div>
                <input id="f_PLAYLIST_META_TIMEOUT_MS" type="number" min="1000" placeholder="10000" data-i18n-ph="ph.playlistMetaTimeout">
                </div>

                <div class="form-group">
                <label for="f_PLAYLIST_META_FALLBACK_TIMEOUT_MS" class="settings-field-label">PLAYLIST_META_FALLBACK_TIMEOUT_MS</label>
                <div class="settings-field-hint muted" data-i18n="settings.playlistMetaFallback">Playlist metadata fallback için timeout (ms)</div>
                <input id="f_PLAYLIST_META_FALLBACK_TIMEOUT_MS" type="number" min="1000" placeholder="5000" data-i18n-ph="ph.playlistMetaFallback">
                </div>
            </section>

            <section class="settings-panel" id="tab-spotify" role="tabpanel">
                <form id="settingsForm" autocomplete="off">
                <div class="form-group">
                    <label for="f_SPOTIFY_CLIENT_ID" class="settings-field-label">SPOTIFY_CLIENT_ID</label>
                    <div class="settings-field-hint muted" data-i18n="settings.spotifyClientId"></div>
                    <input id="f_SPOTIFY_CLIENT_ID" type="text">
                </div>

                <div class="form-group">
                    <label for="f_SPOTIFY_CLIENT_SECRET" class="settings-field-label">SPOTIFY_CLIENT_SECRET</label>
                    <div class="settings-field-hint muted" data-i18n="settings.spotifyClientSecret"></div>
                    <input id="f_SPOTIFY_CLIENT_SECRET" type="password" placeholder="••••••••" data-i18n-ph="ph.spotifyClientSecret" autocomplete="off">
                </div>

                <div class="form-group">
                    <label for="f_SPOTIFY_MARKET" class="settings-field-label">SPOTIFY_MARKET</label>
                    <div class="settings-field-hint muted" data-i18n="settings.spotifyMarket"></div>
                    <input id="f_SPOTIFY_MARKET" type="text" placeholder="TR, US, GB vb." data-i18n-ph="ph.spotifyMarket">
                </div>

                <div class="form-group">
                    <label for="f_SPOTIFY_DEBUG_MARKET" class="settings-field-label">SPOTIFY_DEBUG_MARKET</label>
                    <div class="settings-field-hint muted" data-i18n="settings.spotifyDebugMarket"></div>
                    <select id="f_SPOTIFY_DEBUG_MARKET">
                    <option value="1">1</option>
                    <option value="0">0</option>
                    </select>
                </div>

                <div class="form-group">
                    <label for="f_SPOTIFY_FALLBACK_MARKETS" class="settings-field-label">SPOTIFY_FALLBACK_MARKETS</label>
                    <div class="settings-field-hint muted" data-i18n="settings.spotifyFallbackMarkets"></div>
                    <input id="f_SPOTIFY_FALLBACK_MARKETS" type="text" placeholder="US,GB,DE,FR" data-i18n-ph="ph.spotifyFallbackMarkets">
                </div>

                <div class="form-group">
                    <label for="f_PREFER_SPOTIFY_TAGS" class="settings-field-label">PREFER_SPOTIFY_TAGS</label>
                    <div class="settings-field-hint muted" data-i18n="settings.preferSpotifyTags"></div>
                    <select id="f_PREFER_SPOTIFY_TAGS">
                    <option value="1">1</option>
                    <option value="0">0</option>
                    </select>
                </div>

                <div class="form-group">
                    <label for="f_ENRICH_SPOTIFY_FOR_YT" class="settings-field-label">ENRICH_SPOTIFY_FOR_YT</label>
                    <div class="settings-field-hint muted" data-i18n="settings.enrichSpforYy"></div>
                    <select id="f_ENRICH_SPOTIFY_FOR_YT">
                    <option value="1">1</option>
                    <option value="0">0</option>
                    </select>
                </div>
                </form>
            </section>

            <section class="settings-panel" id="tab-youtube" role="tabpanel">
                <div class="form-group">
                <label for="f_YT_SEARCH_RESULTS" class="settings-field-label">YT_SEARCH_RESULTS</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytSearchResults"></div>
                <input id="f_YT_SEARCH_RESULTS" type="number" min="1" placeholder="10" data-i18n-ph="ph.ytSearchResults">
                </div>

                <div class="form-group">
                <label for="f_YT_SEARCH_TIMEOUT_MS" class="settings-field-label">YT_SEARCH_TIMEOUT_MS</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytSearchTimeout"></div>
                <input id="f_YT_SEARCH_TIMEOUT_MS" type="number" min="1000" placeholder="25000" data-i18n-ph="ph.ytSearchTimeout">
                </div>

                <div class="form-group">
                <label for="f_YT_SEARCH_STAGGER_MS" class="settings-field-label">YT_SEARCH_STAGGER_MS</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytSearchStagger"></div>
                <input id="f_YT_SEARCH_STAGGER_MS" type="number" min="0" placeholder="200" data-i18n-ph="ph.ytSearchStagger">
                </div>

                <div class="form-group">
                <label for="f_YT_UI_FORCE_COOKIES" class="settings-field-label">YT_UI_FORCE_COOKIES</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytUiForceCookies"></div>
                <select id="f_YT_UI_FORCE_COOKIES">
                    <option value="1">1</option>
                    <option value="0">0</option>
                </select>
                </div>

                <div class="form-group">
                <label for="f_YT_USE_MUSIC" class="settings-field-label">YT_USE_MUSIC</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytUseMusic"></div>
                <select id="f_YT_USE_MUSIC">
                    <option value="1">1</option>
                    <option value="0">0</option>
                </select>
                </div>

                <div class="form-group">
                <label for="f_YT_DEFAULT_REGION" class="settings-field-label">YT_DEFAULT_REGION</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytDefaultRegion"></div>
                <input id="f_YT_DEFAULT_REGION" type="text" placeholder="ör: TR, US (boş = kapalı)" data-i18n-ph="ph.ytDefaultRegion">
                </div>

                <div class="form-group">
                <label for="f_YT_LANG" class="settings-field-label">YT_LANG</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytLang"></div>
                <input id="f_YT_LANG" type="text" placeholder="en-US, tr-TR ..." data-i18n-ph="ph.ytLang">
                </div>

                <div class="form-group">
                <label for="f_YT_ACCEPT_LANGUAGE" class="settings-field-label">YT_ACCEPT_LANGUAGE</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytAcceptLang"></div>
                <input id="f_YT_ACCEPT_LANGUAGE" type="text" placeholder="en-US,en;q=0.8 (opsiyonel)" data-i18n-ph="ph.ytAcceptLang">
                </div>

                <div class="form-group">
                <label for="f_YT_FORCE_IPV4" class="settings-field-label">YT_FORCE_IPV4</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytForceIpv4"></div>
                <select id="f_YT_FORCE_IPV4">
                    <option value="1">1</option>
                    <option value="0">0</option>
                </select>
                </div>

                <div class="form-group">
                <label for="f_YT_403_WORKAROUNDS" class="settings-field-label">YT_403_WORKAROUNDS</label>
                <div class="settings-field-hint muted" data-i18n="settings.workarounds"></div>
                <select id="f_YT_403_WORKAROUNDS">
                    <option value="1">1</option>
                    <option value="0">0</option>
                </select>
                </div>

                <div class="form-group">
                <label for="f_YTDLP_UA" class="settings-field-label">YTDLP_UA</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytdlpUA"></div>
                <input id="f_YTDLP_UA" type="text" placeholder="User-Agent (opsiyonel)" data-i18n-ph="ph.ytdlpUA">
                </div>

                <div class="form-group">
                <label for="f_YTDLP_COOKIES" class="settings-field-label">YTDLP_COOKIES</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytdlpCookies"></div>
                <input id="f_YTDLP_COOKIES" type="text" placeholder="/path/to/cookies.txt (opsiyonel)" data-i18n-ph="ph.ytdlpCookies">
                </div>

                <div class="form-group">
                <label for="f_YTDLP_COOKIES_FROM_BROWSER" class="settings-field-label">YTDLP_COOKIES_FROM_BROWSER</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytdlpBrowser"></div>
                <select id="f_YTDLP_COOKIES_FROM_BROWSER">
                    <option value="" data-i18n="common.off"></option>
                    <option value="chrome">chrome</option>
                    <option value="chromium">chromium</option>
                    <option value="firefox">firefox</option>
                    <option value="edge">edge</option>
                </select>
                </div>

                <div class="form-group">
                <label for="f_YTDLP_EXTRA" class="settings-field-label">YTDLP_EXTRA</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytdlpExtra"></div>
                <input id="f_YTDLP_EXTRA" type="text" placeholder="Ek argümanlar, ör: --http-chunk-size 10M" data-i18n-ph="ph.ytdlpExtra">
                </div>

                <div class="form-group">
                <label for="f_YT_STRIP_COOKIES" class="settings-field-label">YT_STRIP_COOKIES</label>
                <div class="settings-field-hint muted" data-i18n="settings.ytdlpSCookies"></div>
                <select id="f_YT_STRIP_COOKIES">
                    <option value="0">0</option>
                    <option value="1">1</option>
                </select>
                </div>
            </section>

            <section class="settings-panel" id="tab-widget" role="tabpanel">
                <div class="form-group">
                <label for="f_HOMEPAGE_WIDGET_KEY" class="settings-field-label">HOMEPAGE_WIDGET_KEY</label>
                <div
                    class="settings-field-hint muted"
                    data-i18n="settings.homepageWidgetKey.hint"
                >${this.t('settings.homepageWidgetKey.hint')}</div>

                <div style="display:flex; gap:8px; align-items:center;">
                    <input id="f_HOMEPAGE_WIDGET_KEY" type="password" placeholder="••••••••" autocomplete="off" style="flex:1;">

                    <button
                    id="toggleWidgetKeyBtn"
                    type="button"
                    class="btn-outline"
                    title="${this.t('settings.homepageWidgetKey.toggleTitle')}"
                    aria-label="${this.t('settings.homepageWidgetKey.toggleTitle')}"
                    data-i18n-title="settings.homepageWidgetKey.toggleTitle"
                    data-i18n-aria="settings.homepageWidgetKey.toggleTitle"
                    style="width:42px; padding:0; display:flex; align-items:center; justify-content:center;">
                    👁️
                    </button>

                    <button
                    id="copyWidgetKeyBtn"
                    type="button"
                    class="btn-outline"
                    title="${this.t('settings.homepageWidgetKey.copyTitle')}"
                    aria-label="${this.t('settings.homepageWidgetKey.copyTitle')}"
                    data-i18n-title="settings.homepageWidgetKey.copyTitle"
                    data-i18n-aria="settings.homepageWidgetKey.copyTitle"
                    style="width:42px; padding:0; display:flex; align-items:center; justify-content:center;">
                    📋
                    </button>

                    <button
                    id="genWidgetKeyBtn"
                    type="button"
                    class="btn-outline"
                    data-i18n="settings.homepageWidgetKey.rotateBtn"
                    >${this.t('settings.homepageWidgetKey.rotateBtn')}</button>
                </div>
                </div>
            </section>

            <section class="settings-panel is-active" id="tab-updates" role="tabpanel">
                <div class="form-group">
                <span class="settings-field-label" data-i18n="version.updateCheck">
                    ${this.t('version.updateCheck')}
                </span>
                <div style="display:flex; gap:8px;">
                    <button type="button" id="checkUpdatesBtn" class="btn-outline" style="flex:1;" data-i18n="version.checkUpdates">
                    ${this.t('version.checkUpdates')}
                    </button>
                </div>
                </div>
            </section>

            <section class="settings-panel" id="tab-password" role="tabpanel">
                <form id="changePasswordForm" autocomplete="off">
                <div hidden>
                    <label for="adminUserChange" class="settings-field-label">Admin Kullanıcı Adı</label>
                    <input id="adminUserChange" type="text" name="username" autocomplete="username" value="admin" />
                </div>

                <h4 class="settings-section-title" data-i18n="settings.adminPassword">Yönetici Şifresi</h4>

                <div class="form-group">
                    <label for="f_ADMIN_OLD" class="settings-field-label" data-i18n="settings.currentPassword">Eski Şifre</label>
                    <input id="f_ADMIN_OLD" type="password" placeholder="••••••••" data-i18n-ph="settings.currentPassword" autocomplete="current-password" />
                </div>

                <div class="form-group">
                    <label for="f_ADMIN_NEW" class="settings-field-label" data-i18n="settings.newPassword">Yeni Şifre</label>
                    <input id="f_ADMIN_NEW" type="password" placeholder="En az 6 karakter" data-i18n-ph="settings.newPassword" autocomplete="new-password" />
                </div>

                <div class="form-group">
                    <label for="f_ADMIN_NEW2" class="settings-field-label" data-i18n="settings.newPassword2">Yeni Şifre (Tekrar)</label>
                    <input id="f_ADMIN_NEW2" type="password" placeholder="Yeni Şifre (Tekrar)" data-i18n-ph="settings.newPassword2" autocomplete="new-password" />
                </div>

                <div class="settings-actions settings-actions--end">
                    <button id="changePassBtn" type="button" class="btn-primary" data-i18n="btn.changePassword">Şifreyi Güncelle</button>
                </div>
                </form>
            </section>
            </div>

            <div class="settings-actions settings-actions--between">
            <button id="logoutBtn" type="button" class="btn-outline" data-i18n="btn.logout">Çıkış</button>
            <div class="settings-actions__right">
                <button id="reloadBtn" type="button" class="btn-outline" data-i18n="btn.reload">Yenile</button>
                <button id="saveBtn" type="button" class="btn-primary" data-i18n="btn.save">Kaydet</button>
            </div>
            </div>
        </div>
        </div>
    `;
    }

    // Updates event listeners used for the browser UI layer.
    setupEventListeners() {
    document.getElementById('settingsClose').onclick = () => this.close();
    document.getElementById('loginBtn').onclick = () => this.doLogin();
    document.getElementById('logoutBtn').onclick = () => this.doLogout();
    document.getElementById('checkUpdatesBtn').onclick = () => {
        if (window.versionManager) {
            window.versionManager.checkNow();
            this.showNotification(this.t('version.checkingProgress'), 'info');
        } else {
            console.error('VersionManager not available');
            this.showNotification(this.t('version.systemUnavailable'), 'error');
        }
    };

    document.getElementById('reloadBtn').onclick = () => this.loadSettings();
    document.getElementById('saveBtn').onclick = () => this.saveSettings();
    document.getElementById('changePassBtn').onclick = () => this.changePassword();
    document.getElementById('genWidgetKeyBtn').onclick = () => this.generateHomepageWidgetKey();
    document.getElementById('toggleWidgetKeyBtn').onclick = () => this.toggleHomepageWidgetKeyVisibility();
    document.getElementById('copyWidgetKeyBtn').onclick = () => this.copyHomepageWidgetKey();
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && this.modal.style.display === 'flex') {
            const loginView = document.getElementById('loginView');
            if (loginView && loginView.style.display !== 'none') {
                e.preventDefault();
                this.doLogin();
            }
        }
    });
    this.setupTabs();
        const toggleBtn = document.getElementById('toggleWidgetKeyBtn');
        if (toggleBtn) {
        const t = this.t('settings.homepageWidgetKey.toggleTitle');
        toggleBtn.title = t;
        toggleBtn.setAttribute('aria-label', t);
        }
        const copyBtn = document.getElementById('copyWidgetKeyBtn');
        if (copyBtn) {
        const t = this.t('settings.homepageWidgetKey.copyTitle');
        copyBtn.title = t;
        copyBtn.setAttribute('aria-label', t);
        }
    }

    // Opens login only in the browser UI layer.
    openLoginOnly() {
        if (!this.isInitialized) this.initialize();

        this.loginOnly = true;

        this.modal.style.display = 'flex';
        this.modal.setAttribute('aria-hidden', 'false');
        this.modal.removeAttribute('inert');

        this.showLogin();
        requestAnimationFrame(() => document.getElementById('adminPass')?.focus());
    }

    // Opens open in the browser UI layer.
    open() {
        if (!this.isInitialized) this.initialize();

        this.modal.style.display = 'flex';
        this.modal.setAttribute('aria-hidden', 'false');
        this.modal.removeAttribute('inert');
        const token = localStorage.getItem(this.tokenKey);

        if (token) {
            this.showForm();
            this.loadSettings();
        } else {
            this.showLogin();
            requestAnimationFrame(() => document.getElementById('adminPass')?.focus());
        }
    }

    // Closes close in the browser UI layer.
    close() {
    if (this.modal) {
        this.modal.style.display = 'none';
        this.modal.setAttribute('aria-hidden', 'true');
        this.modal.setAttribute('inert', '');
    }
    document.getElementById('settingsBtn')?.focus();
    }

    // Shows login in the browser UI layer.
    showLogin() {
        document.getElementById('loginView').style.display = 'flex';
        document.getElementById('formView').style.display = 'none';
        document.getElementById('adminPass').value = '';
        document.getElementById('adminError').style.display = 'none';
    }

    // Shows form in the browser UI layer.
    showForm() {
        document.getElementById('loginView').style.display = 'none';
        document.getElementById('formView').style.display = 'block';
    }

    // Handles do login in the browser UI layer.
    async doLogin() {
        const password = document.getElementById('adminPass').value;
        const errEl = document.getElementById('adminError');
        const btn = document.getElementById('loginBtn');
        const passEl = document.getElementById('adminPass');

        if (errEl) {
            errEl.style.display = 'none';
            errEl.textContent = '';
        }

        if (!password) {
            if (errEl) {
                errEl.textContent = this.t('errors.emptyPassword', 'Please enter the password.');
                errEl.style.display = 'block';
            }
            passEl?.focus();
            return;
        }

        try {
            btn?.classList.add('btn-loading');
            btn && (btn.disabled = true);

            const r = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                const code = e?.error?.code;
                let msg =
                    (code === 'BAD_PASSWORD') ? this.t('errors.BAD_PASSWORD', 'Wrong password.') :
                    (code === 'NO_ADMIN_PASSWORD') ? this.t('errors.NO_ADMIN_PASSWORD', 'ADMIN_PASSWORD is not set on server.') :
                    (e?.error?.message || this.tt('errors.loginFailed', 'Login failed.'));
                throw new Error(msg);
            }

            const data = await r.json();

            localStorage.setItem(this.tokenKey, data.token);
            window.dispatchEvent(new CustomEvent('gharmonize:auth', {
                detail: { loggedIn: true }
            }));

            if (this.loginOnly) {
                this.loginOnly = false;
                this.close();
                return;
            }
            this.showForm();
            await this.loadSettings();

        } catch (e) {
            if (errEl) {
                errEl.textContent = String(e.message || 'Giriş hatası');
                errEl.style.display = 'block';
            }
            passEl?.classList.add('shake');
            setTimeout(() => passEl?.classList.remove('shake'), 350);
            passEl?.focus();
        } finally {
            btn?.classList.remove('btn-loading');
            btn && (btn.disabled = false);
        }
    }

    // Handles do logout in the browser UI layer.
    async doLogout() {
        localStorage.removeItem(this.tokenKey);
        this.triggerGlobalLogout();
        this.showLogin();
        requestAnimationFrame(() => document.getElementById('adminPass')?.focus());
    }

    // Handles trigger global logout in the browser UI layer.
    triggerGlobalLogout() {
        window.dispatchEvent(new CustomEvent('gharmonize:auth', {
            detail: { loggedIn: false }
        }));
        if (window.jobsPanelManager) {
            window.jobsPanelManager.goOffline();
        }
    }

    // Loads settings for the browser UI layer.
    async loadSettings() {
        const token = localStorage.getItem(this.tokenKey) || "";
        try {
            const r = await fetch('/api/settings', {
                headers: { 'Authorization': 'Bearer ' + token }
            });

            if (r.status === 401) {
                this.showLogin();
                return;
            }

            const data = await r.json();
            const s = data.settings || {};

            document.getElementById('f_SPOTIFY_CLIENT_ID').value = s.SPOTIFY_CLIENT_ID || '';
            document.getElementById('f_SPOTIFY_CLIENT_SECRET').value = '';
            document.getElementById('f_SPOTIFY_DEBUG_MARKET').value = s.SPOTIFY_DEBUG_MARKET || '';
            document.getElementById('f_SPOTIFY_MARKET').value = s.SPOTIFY_MARKET || '';
            document.getElementById('f_SPOTIFY_FALLBACK_MARKETS').value = s.SPOTIFY_FALLBACK_MARKETS || '';
            document.getElementById('f_YT_USE_MUSIC').value = s.YT_USE_MUSIC || '0';
            document.getElementById('f_PREFER_SPOTIFY_TAGS').value = s.PREFER_SPOTIFY_TAGS || '1';
            document.getElementById('f_TITLE_CLEAN_PIPE').value = s.TITLE_CLEAN_PIPE || '1';
            document.getElementById('f_YTDLP_UA').value = s.YTDLP_UA || '';
            document.getElementById('f_CLEAN_SUFFIXES').value = s.CLEAN_SUFFIXES || 'topic,official';
            document.getElementById('f_CLEAN_PHRASES').value = s.CLEAN_PHRASES || 'official channel,Official Video';
            document.getElementById('f_CLEAN_PARENS').value = s.CLEAN_PARENS || 'official,topic';
            document.getElementById('f_YTDLP_COOKIES').value = s.YTDLP_COOKIES || '';
            document.getElementById('f_YTDLP_COOKIES_FROM_BROWSER').value = s.YTDLP_COOKIES_FROM_BROWSER || '';
            document.getElementById('f_YTDLP_EXTRA').value = s.YTDLP_EXTRA || '';
            document.getElementById('f_YT_STRIP_COOKIES').value = (typeof s.YT_STRIP_COOKIES !== 'undefined' && s.YT_STRIP_COOKIES !== null)
                ? String(s.YT_STRIP_COOKIES)
                : '0';
            document.getElementById('f_YT_DEFAULT_REGION').value = s.YT_DEFAULT_REGION || '';
            document.getElementById('f_YT_LANG').value = s.YT_LANG || 'en-US';
            document.getElementById('f_YT_ACCEPT_LANGUAGE').value = s.YT_ACCEPT_LANGUAGE || '';
            document.getElementById('f_YT_FORCE_IPV4').value = (typeof s.YT_FORCE_IPV4 !== 'undefined' && s.YT_FORCE_IPV4 !== null) ? String(s.YT_FORCE_IPV4) : '1';
            document.getElementById('f_YT_403_WORKAROUNDS').value = (typeof s.YT_403_WORKAROUNDS !== 'undefined' && s.YT_403_WORKAROUNDS !== null) ? String(s.YT_403_WORKAROUNDS) : '1';
            document.getElementById('f_ENRICH_SPOTIFY_FOR_YT').value = s.ENRICH_SPOTIFY_FOR_YT || '1';
            document.getElementById('f_MEDIA_COMMENT').value = s.MEDIA_COMMENT || 'Gharmonize';
            document.getElementById('f_FFMPEG_BIN').value = s.FFMPEG_BIN || '';
            document.getElementById('f_YTDLP_BIN').value = s.YTDLP_BIN || '';
            document.getElementById('f_UPLOAD_MAX_BYTES').value = s.UPLOAD_MAX_BYTES || '';
            document.getElementById('f_PREVIEW_MAX_ENTRIES').value = s.PREVIEW_MAX_ENTRIES || '1000';
            document.getElementById('f_AUTOMIX_ALL_TIMEOUT_MS').value = s.AUTOMIX_ALL_TIMEOUT_MS || '60000';
            document.getElementById('f_AUTOMIX_PAGE_TIMEOUT_MS').value = s.AUTOMIX_PAGE_TIMEOUT_MS || '60000';
            document.getElementById('f_PLAYLIST_ALL_TIMEOUT_MS').value = s.PLAYLIST_ALL_TIMEOUT_MS || '45000';
            document.getElementById('f_PLAYLIST_PAGE_TIMEOUT_MS').value = s.PLAYLIST_PAGE_TIMEOUT_MS || '45000';
            document.getElementById('f_PLAYLIST_META_TIMEOUT_MS').value = s.PLAYLIST_META_TIMEOUT_MS || '15000';
            document.getElementById('f_PLAYLIST_META_FALLBACK_TIMEOUT_MS').value = s.PLAYLIST_META_FALLBACK_TIMEOUT_MS || '15000';
            document.getElementById('f_YT_UI_FORCE_COOKIES').value = s.YT_UI_FORCE_COOKIES || '1';
            document.getElementById('f_YT_SEARCH_RESULTS').value = s.YT_SEARCH_RESULTS || '3';
            document.getElementById('f_YT_SEARCH_TIMEOUT_MS').value = s.YT_SEARCH_TIMEOUT_MS || '25000';
            document.getElementById('f_YT_SEARCH_STAGGER_MS').value = s.YT_SEARCH_STAGGER_MS || '180';
            document.getElementById('f_HOMEPAGE_WIDGET_KEY').value = s.HOMEPAGE_WIDGET_KEY || '';

        } catch (e) {
            modalManager.showAlert({
                title: this.t('settings.title') || 'Ayarlar',
                message: this.t('settings.errorLoading', 'Failed to load settings.') + ': ' + e.message,
                type: 'danger'
            });
        }
    }

    // Persists settings for the browser UI layer.
    async saveSettings() {
        const token = localStorage.getItem(this.tokenKey) || "";
        const payload = {
            settings: {
                SPOTIFY_CLIENT_ID: document.getElementById('f_SPOTIFY_CLIENT_ID').value.trim(),
                SPOTIFY_CLIENT_SECRET: document.getElementById('f_SPOTIFY_CLIENT_SECRET').value.trim(),
                SPOTIFY_DEBUG_MARKET: document.getElementById('f_SPOTIFY_DEBUG_MARKET').value.trim(),
                SPOTIFY_MARKET: document.getElementById('f_SPOTIFY_MARKET').value.trim(),
                SPOTIFY_FALLBACK_MARKETS: document.getElementById('f_SPOTIFY_FALLBACK_MARKETS').value.trim(),
                YT_USE_MUSIC: document.getElementById('f_YT_USE_MUSIC').value,
                PREFER_SPOTIFY_TAGS: document.getElementById('f_PREFER_SPOTIFY_TAGS').value,
                TITLE_CLEAN_PIPE: document.getElementById('f_TITLE_CLEAN_PIPE').value,
                CLEAN_SUFFIXES: document.getElementById('f_CLEAN_SUFFIXES').value,
                CLEAN_PHRASES: document.getElementById('f_CLEAN_PHRASES').value,
                CLEAN_PARENS: document.getElementById('f_CLEAN_PARENS').value,
                YTDLP_UA: document.getElementById('f_YTDLP_UA').value,
                YTDLP_COOKIES: document.getElementById('f_YTDLP_COOKIES').value,
                YTDLP_COOKIES_FROM_BROWSER: document.getElementById('f_YTDLP_COOKIES_FROM_BROWSER').value,
                YTDLP_EXTRA: document.getElementById('f_YTDLP_EXTRA').value,
                YT_STRIP_COOKIES: document.getElementById('f_YT_STRIP_COOKIES').value,
                YT_DEFAULT_REGION: document.getElementById('f_YT_DEFAULT_REGION').value.trim(),
                YT_LANG: document.getElementById('f_YT_LANG').value.trim(),
                YT_ACCEPT_LANGUAGE: document.getElementById('f_YT_ACCEPT_LANGUAGE').value.trim(),
                YT_FORCE_IPV4: document.getElementById('f_YT_FORCE_IPV4').value,
                YT_403_WORKAROUNDS: document.getElementById('f_YT_403_WORKAROUNDS').value,
                ENRICH_SPOTIFY_FOR_YT: document.getElementById('f_ENRICH_SPOTIFY_FOR_YT').value,
                MEDIA_COMMENT: document.getElementById('f_MEDIA_COMMENT').value.trim(),
                YTDLP_BIN: document.getElementById('f_YTDLP_BIN').value.trim(),
                FFMPEG_BIN: document.getElementById('f_FFMPEG_BIN').value.trim(),
                UPLOAD_MAX_BYTES: document.getElementById('f_UPLOAD_MAX_BYTES').value.trim(),
                PREVIEW_MAX_ENTRIES: document.getElementById('f_PREVIEW_MAX_ENTRIES').value.trim(),
                AUTOMIX_ALL_TIMEOUT_MS: document.getElementById('f_AUTOMIX_ALL_TIMEOUT_MS').value.trim(),
                AUTOMIX_PAGE_TIMEOUT_MS: document.getElementById('f_AUTOMIX_PAGE_TIMEOUT_MS').value.trim(),
                PLAYLIST_ALL_TIMEOUT_MS: document.getElementById('f_PLAYLIST_ALL_TIMEOUT_MS').value.trim(),
                PLAYLIST_PAGE_TIMEOUT_MS: document.getElementById('f_PLAYLIST_PAGE_TIMEOUT_MS').value.trim(),
                PLAYLIST_META_TIMEOUT_MS: document.getElementById('f_PLAYLIST_META_TIMEOUT_MS').value.trim(),
                PLAYLIST_META_FALLBACK_TIMEOUT_MS: document.getElementById('f_PLAYLIST_META_FALLBACK_TIMEOUT_MS').value.trim(),
                YT_UI_FORCE_COOKIES: document.getElementById('f_YT_UI_FORCE_COOKIES').value,
                YT_SEARCH_RESULTS: document.getElementById('f_YT_SEARCH_RESULTS').value.trim(),
                YT_SEARCH_TIMEOUT_MS: document.getElementById('f_YT_SEARCH_TIMEOUT_MS').value.trim(),
                YT_SEARCH_STAGGER_MS: document.getElementById('f_YT_SEARCH_STAGGER_MS').value.trim(),
                HOMEPAGE_WIDGET_KEY: document.getElementById('f_HOMEPAGE_WIDGET_KEY').value.trim(),
            }
        };

        try {
            const r = await fetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify(payload)
            });

            if (r.status === 401) {
                this.showLogin();
                return;
            }

            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                throw new Error(e?.error?.message || this.t('errors.saveFailed'));
            }

            modalManager.showAlert({
                title: this.t('settings.title') || 'Ayarlar',
                message: this.t('settings.saved', 'Settings saved.'),
                type: 'success'
            });
        } catch (e) {
            modalManager.showAlert({
                title: this.t('settings.title') || 'Ayarlar',
                message: this.t('settings.errorSaving', 'Failed to save settings.') + ': ' + e.message,
                type: 'danger'
            });
        }
    }

    // Handles change password in the browser UI layer.
    async changePassword() {
        const token = localStorage.getItem(this.tokenKey) || "";
        const oldPassword = document.getElementById('f_ADMIN_OLD').value;
        const newPassword = document.getElementById('f_ADMIN_NEW').value;
        const newPassword2 = document.getElementById('f_ADMIN_NEW2').value;

        if (!oldPassword || !newPassword || !newPassword2) {
            modalManager.showAlert({
                title: this.t('settings.title') || 'Ayarlar',
                message: this.t('settings.errors.fieldsRequired') || 'All fields are required.',
                type: 'warning'
            });
            return;
        }

        if (newPassword !== newPassword2) {
            modalManager.showAlert({
                title: this.t('settings.title') || 'Ayarlar',
                message: this.t('settings.errors.passwordMismatch') || 'Passwords do not match',
                type: 'warning'
            });
            return;
        }

        if (String(newPassword).length < 6) {
            modalManager.showAlert({
                title: this.t('settings.title') || 'Ayarlar',
                message: this.t('settings.errors.passwordTooShort') || 'Password must be at least 6 characters.',
                type: 'warning'
            });
            return;
        }

        try {
            const r = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ oldPassword, newPassword, newPassword2 })
            });

            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                const code = e?.error?.code;
                const map = {
                    BAD_PASSWORD: 'errors.BAD_PASSWORD2',
                    PASSWORD_MISMATCH: 'errors.PASSWORD_MISMATCH',
                    PASSWORD_TOO_SHORT: 'errors.PASSWORD_TOO_SHORT',
                    FIELDS_REQUIRED: 'errors.FIELDS_REQUIRED',
                    PASSWORD_SAVE_FAILED: 'errors.PASSWORD_SAVE_FAILED',
                    UNAUTHORIZED: 'errors.UNAUTHORIZED'
                };
                const key = map[code] || 'errors.changePasswordFailed';
                const msg = this.t(key) || (e?.error?.message || 'Password change failed');
                throw new Error(msg);
            }

            const data = await r.json();
            modalManager.showAlert({
                title: this.t('settings.title') || 'Ayarlar',
                message: this.t('settings.passwordChanged') || 'Password updated. Please log in again.',
                type: 'success'
            });

            if (data.logout) {
                localStorage.removeItem(this.tokenKey);
                window.dispatchEvent(new CustomEvent('gharmonize:auth', { detail: { loggedIn: false } }));
                document.getElementById('f_ADMIN_OLD').value = '';
                document.getElementById('f_ADMIN_NEW').value = '';
                document.getElementById('f_ADMIN_NEW2').value = '';
                this.showLogin();
            }
        } catch (e) {
            modalManager.showAlert({
                title: this.t('settings.title') || 'Ayarlar',
                message: String(e.message || this.t('errors.changePasswordFailed', 'Password change failed.')),
                type: 'danger'
            });
        }
    }

    // Generates homepage widget key for the browser UI layer.
    async generateHomepageWidgetKey() {
        const token = localStorage.getItem(this.tokenKey) || "";
        const btn = document.getElementById('genWidgetKeyBtn');
        try {
            btn?.classList.add('btn-loading');
            btn && (btn.disabled = true);

            const r = await fetch('/api/settings/homepage-widget-key', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ rotate: true, reveal: true })
            });

            if (r.status === 401) {
            this.showLogin();
            return;
            }
            if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(e?.error?.message || this.tt('settings.homepageWidgetKey.rotateFailed', 'Failed to generate the key.'));
            }

            const data = await r.json();
            const key = data?.key;
            const el = document.getElementById('f_HOMEPAGE_WIDGET_KEY');
            if (el) {
            el.type = 'password';
            el.value = '••••••••';
            }
            const eyeBtn = document.getElementById('toggleWidgetKeyBtn');
            if (eyeBtn) eyeBtn.textContent = '👁️';
            if (key && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(key);
            this.showNotification(this.t('settings.homepageWidgetKey.rotatedAndCopied'), 'success');
            } else {
            this.showNotification(this.t('settings.homepageWidgetKey.rotated'), 'success');
            }

        } catch (e) {
            this.showNotification(String(e.message || this.t('settings.homepageWidgetKey.rotateFailed')), 'error');
        } finally {
            btn?.classList.remove('btn-loading');
            btn && (btn.disabled = false);
        }
    }

    // Handles toggle homepage widget key visibility in the browser UI layer.
    async toggleHomepageWidgetKeyVisibility() {
      const el = document.getElementById('f_HOMEPAGE_WIDGET_KEY');
      const btn = document.getElementById('toggleWidgetKeyBtn');
      const token = localStorage.getItem(this.tokenKey) || "";
      if (!el) return;

      const wantsShow = (el.type === 'password');
      if (wantsShow) {
        const cur = (el.value || '').trim();
        if (!cur || cur === '••••••••') {
          try {
            btn?.classList.add('btn-loading');
            btn && (btn.disabled = true);

            const r = await fetch('/api/settings/homepage-widget-key', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
              },
              body: JSON.stringify({ rotate: false, reveal: true })
            });

            if (r.status === 401) {
              this.showLogin();
              return;
            }
            if (!r.ok) {
              const e = await r.json().catch(() => ({}));
              throw new Error(e?.error?.message || this.t('settings.homepageWidgetKey.fetchFailed'));
            }

            const data = await r.json();
            const key = (data?.key || '').trim();
            if (!key) {
              this.showNotification(this.t('settings.homepageWidgetKey.noKeyExists'), 'error');
              return;
            }

            el.value = key;
          } catch (e) {
            this.showNotification(String(e.message || this.t('settings.homepageWidgetKey.fetchFailed')), 'error');
            return;
          } finally {
            btn?.classList.remove('btn-loading');
            btn && (btn.disabled = false);
          }
        }

        el.type = 'text';
        if (btn) btn.textContent = '🙈';
        return;
      }

      el.type = 'password';
      el.value = '••••••••';
      if (btn) btn.textContent = '👁️';
    }

        // Handles copy homepage widget key in the browser UI layer.
        async copyHomepageWidgetKey() {
        const token = localStorage.getItem(this.tokenKey) || "";
        const btn = document.getElementById('copyWidgetKeyBtn');

        try {
            btn?.classList.add('btn-loading');
            btn && (btn.disabled = true);

            const el = document.getElementById('f_HOMEPAGE_WIDGET_KEY');
            const currentVal = (el?.value || '').trim();

            let keyToCopy = null;
            if (currentVal && currentVal !== '••••••••') {
            keyToCopy = currentVal;
            } else {
            const r = await fetch('/api/settings/homepage-widget-key', {
                method: 'POST',
                headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ rotate: false, reveal: true })
            });

            if (r.status === 401) {
                this.showLogin();
                return;
            }
            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                throw new Error(e?.error?.message || this.t('settings.homepageWidgetKey.fetchFailed'));
            }

            const data = await r.json();
            keyToCopy = data?.key || null;
            }

            if (!keyToCopy) {
            this.showNotification(this.t('settings.homepageWidgetKey.noKeyToCopy'), 'error');
            return;
            }

            if (!navigator.clipboard?.writeText) {
            const tmp = document.createElement('textarea');
            tmp.value = keyToCopy;
            tmp.style.position = 'fixed';
            tmp.style.left = '-9999px';
            document.body.appendChild(tmp);
            tmp.select();
            document.execCommand('copy');
            document.body.removeChild(tmp);
            this.showNotification(this.t('settings.homepageWidgetKey.copied'), 'success');
            return;
            }

            await navigator.clipboard.writeText(keyToCopy);
            this.showNotification(this.t('settings.homepageWidgetKey.copied'), 'success');

        } catch (e) {
            this.showNotification(String(e.message || this.t('settings.homepageWidgetKey.copyFailed')), 'error');
        } finally {
            btn?.classList.remove('btn-loading');
            btn && (btn.disabled = false);
        }
    }

    // Updates tabs used for the browser UI layer.
    setupTabs() {
    const root = this.modal;
    if (!root) return;

    const tabs = Array.from(root.querySelectorAll('.settings-tab'));
    const panels = Array.from(root.querySelectorAll('.settings-panel'));

    // Handles activate in the browser UI layer.
    const activate = (tabId) => {
        for (const t of tabs) {
        const on = t.dataset.tab === tabId;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        for (const p of panels) {
        const on = p.id === tabId;
        p.classList.toggle('is-active', on);
        p.style.display = on ? 'block' : 'none';
        }
    };

    panels.forEach(p => (p.style.display = 'none'));
    activate('tab-system');

    tabs.forEach(t => {
        t.addEventListener('click', () => activate(t.dataset.tab));
    });

    this.activateSettingsTab = activate;
    }

    // Handles t in the browser UI layer.
    t(key, vars) {
        return (window.i18n?.t?.(key, vars)) ?? key;
    }
}

export const settingsManager = new SettingsManager();
