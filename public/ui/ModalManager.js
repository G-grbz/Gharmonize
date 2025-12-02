export class ModalManager {
    constructor() {
        this.modalContainer = null;
        this.init();
    }

    init() {
        const existing = document.getElementById('custom-modal-container');
        if (existing) {
            this.modalContainer = existing;
            return;
        }

        const container = document.createElement('div');
        container.id = 'custom-modal-container';
        container.className = 'custom-modal-backdrop';
        container.setAttribute('role', 'presentation');
        container.style.display = 'none';

        document.body.appendChild(container);
        this.modalContainer = container;
    }

    showConfirm(options) {
        return new Promise((resolve) => {
            const {
                title = 'Onay',
                message = 'Emin misiniz?',
                confirmText = 'Evet',
                cancelText = 'Hayır',
                type = 'warning',
                allowHtml = false
            } = options || {};

            const modal = document.createElement('div');
            const typeIcons = {
                warning: '⚠️',
                disc: '💿',
                danger: '❌',
                success: '✅',
                info: 'ℹ️'
            };

            const typeClass = `custom-modal--${type}`;
            modal.className = `custom-modal ${typeClass}`;

            const safeTitle = this.escapeHtml(title);
            const safeMessage = allowHtml
                ? message
                : this.escapeHtml(message).replace(/\n/g, '<br>');

            modal.innerHTML = `
                <div class="custom-modal__header">
                    <div class="custom-modal__icon">${typeIcons[type] || '⚠️'}</div>
                    <div class="custom-modal__content">
                        <h3 class="custom-modal__title">
                            ${safeTitle}
                        </h3>
                        <div class="custom-modal__message">
                            ${safeMessage}
                        </div>
                    </div>
                </div>
                <div class="custom-modal__footer">
                    <button class="modal-btn modal-btn-cancel" type="button">
                        ${this.escapeHtml(cancelText)}
                    </button>
                    <button class="modal-btn modal-btn-confirm" type="button">
                        ${this.escapeHtml(confirmText)}
                    </button>
                </div>
            `;

            const confirmBtn = modal.querySelector('.modal-btn-confirm');
            const cancelBtn = modal.querySelector('.modal-btn-cancel');
            const backdrop = this.modalContainer;

            if (!backdrop) {
                console.error('❌ modalContainer bulunamadı');
                resolve(false);
                return;
            }

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

            const confirmHandler = () => resolveAndCleanup(true);
            const cancelHandler = () => resolveAndCleanup(false);

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

            confirmBtn.addEventListener('click', confirmHandler);
            cancelBtn.addEventListener('click', cancelHandler);
            document.addEventListener('keydown', escHandler);
            backdrop.addEventListener('click', backdropHandler);
            backdrop.style.display = 'flex';
            backdrop.classList.add('is-open');
            backdrop.appendChild(modal);

            requestAnimationFrame(() => {
                modal.scrollTop = 0;
                const bodyEl = modal.querySelector('.custom-modal__body');
                if (bodyEl) bodyEl.scrollTop = 0;

                const titleEl = modal.querySelector('.custom-modal__title');
                if (titleEl && typeof titleEl.focus === 'function') {
                    titleEl.setAttribute('tabindex', '-1');
                    titleEl.focus();
                } else {
                    cancelBtn.focus();
                }
            });
        });
    }

    showAlert(options) {
        return new Promise((resolve) => {
            const {
                title = 'Bilgi',
                message = '',
                buttonText = 'Tamam',
                type = 'info',
                allowHtml = false
            } = options || {};

            const modal = document.createElement('div');
            const typeIcons = {
                warning: '⚠️',
                disc: '💿',
                danger: '❌',
                success: '✅',
                info: 'ℹ️'
            };

            const typeClass = `custom-modal--${type}`;
            modal.className = `custom-modal ${typeClass}`;

            const safeTitle = this.escapeHtml(title);
            const safeMessage = allowHtml
                ? message
                : this.escapeHtml(message).replace(/\n/g, '<br>');

            modal.innerHTML = `
                <div class="custom-modal__header">
                    <div class="custom-modal__icon">${typeIcons[type] || '💿'}</div>
                    <div class="custom-modal__content">
                        <h3 class="custom-modal__title">
                            ${safeTitle}
                        </h3>
                        <div class="custom-modal__message">
                            ${safeMessage}
                        </div>
                    </div>
                </div>
                <div class="custom-modal__footer">
                    <button class="modal-btn modal-btn-ok" type="button">
                        ${this.escapeHtml(buttonText)}
                    </button>
                </div>
            `;

            const okBtn = modal.querySelector('.modal-btn-ok');
            const backdrop = this.modalContainer;

            if (!backdrop) {
                console.error('❌ modalContainer bulunamadı');
                resolve();
                return;
            }

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

            const resolveAndCleanup = () => {
                cleanup();
                resolve();
            };

            const okHandler = () => resolveAndCleanup();

            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    okHandler();
                }
            };

            const backdropHandler = (e) => {
                if (e.target === backdrop) {
                    okHandler();
                }
            };

            okBtn.addEventListener('click', okHandler);
            document.addEventListener('keydown', escHandler);
            backdrop.addEventListener('click', backdropHandler);

            backdrop.style.display = 'flex';
            backdrop.classList.add('is-open');
            backdrop.appendChild(modal);

            requestAnimationFrame(() => {
                modal.scrollTop = 0;
                const bodyEl = modal.querySelector('.custom-modal__body');
                if (bodyEl) bodyEl.scrollTop = 0;

                const titleEl = modal.querySelector('.custom-modal__title');
                if (titleEl && typeof titleEl.focus === 'function') {
                    titleEl.setAttribute('tabindex', '-1');
                    titleEl.focus();
                } else {
                    okBtn.focus();
                }
            });
        });
    }

    showCustomNode(options) {
        return new Promise((resolve) => {
            const {
                title = 'Pencere',
                node,
                type = 'disc',
                closeText = 'Kapat'
            } = options || {};

            if (!node) {
                resolve();
                return;
            }

            const modal = document.createElement('div');
            const typeIcons = {
                warning: '⚠️',
                disc: '💿',
                danger: '❌',
                success: '✅',
                info: 'ℹ️'
            };

            const typeClass = `custom-modal--${type}`;
            modal.className = `custom-modal ${typeClass}`;

            modal.innerHTML = `
                <div class="custom-modal__header">
                    <div class="custom-modal__icon">${typeIcons[type] || '💿'}</div>
                    <div class="custom-modal__content">
                        <h3 class="custom-modal__title">
                            ${this.escapeHtml(title)}
                        </h3>
                    </div>
                </div>
                <div class="custom-modal__body" id="customModalBody"></div>
                <div class="custom-modal__footer">
                    <button class="modal-btn modal-btn-ok" type="button">
                        ${this.escapeHtml(closeText)}
                    </button>
                </div>
            `;

            const bodyEl = modal.querySelector('#customModalBody');
            const okBtn = modal.querySelector('.modal-btn-ok');
            const backdrop = this.modalContainer;
            const originalParent = node.parentNode;
            const placeholder = document.createElement('div');
            placeholder.id = 'discRipperPlaceholder-' + Date.now();

            if (originalParent) {
                originalParent.replaceChild(placeholder, node);
            }

            bodyEl.appendChild(node);

            const cleanup = () => {
                if (placeholder.parentNode) {
                    placeholder.parentNode.replaceChild(node, placeholder);
                }
                if (modal.parentNode) {
                    modal.parentNode.removeChild(modal);
                }
                if (backdrop && backdrop.children.length === 0) {
                    backdrop.style.display = 'none';
                    backdrop.classList.remove('is-open');
                }
                document.removeEventListener('keydown', escHandler);
                if (backdrop) {
                    backdrop.removeEventListener('click', backdropHandler);
                }
            };

            const resolveAndCleanup = () => {
                cleanup();
                resolve();
            };

            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    resolveAndCleanup();
                }
            };

            const backdropHandler = (e) => {
                if (e.target === backdrop) {
                    resolveAndCleanup();
                }
            };

            okBtn.addEventListener('click', resolveAndCleanup);
            document.addEventListener('keydown', escHandler);

            if (backdrop) {
                backdrop.addEventListener('click', backdropHandler);
                backdrop.style.display = 'flex';
                backdrop.classList.add('is-open');
                backdrop.appendChild(modal);

                requestAnimationFrame(() => {
                    modal.scrollTop = 0;
                    bodyEl.scrollTop = 0;

                    const titleEl = modal.querySelector('.custom-modal__title');
                    if (titleEl && typeof titleEl.focus === 'function') {
                        titleEl.setAttribute('tabindex', '-1');
                        titleEl.focus();
                    } else {
                        okBtn.focus();
                    }
                });
            }
        });
    }

    escapeHtml(str) {
        if (str == null) return "";
        const escapeMap = {
            '&': '&amp;', '<': '&lt;', '>': '&gt;',
            '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;'
        };
        return String(str).replace(/[&<>"'`=\/]/g, s => escapeMap[s] || s);
    }

    destroy() {
        if (this.modalContainer) {
            this.modalContainer.remove();
            this.modalContainer = null;
        }
    }
}

export const modalManager = new ModalManager();

if (typeof window !== 'undefined') {
    window.modalManager = modalManager;
}
