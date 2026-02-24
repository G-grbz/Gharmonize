export class NotificationManager {
    // Initializes class state and defaults for the browser UI layer.
    constructor() {
        this.notificationQueue = new Map();
        this.activeNotifications = new Set();
        this.notificationTimers = new Map();
        this.ensureStyles();
    }

    // Handles ensure styles in the browser UI layer.
    ensureStyles() {
        if (document.getElementById('notification-styles')) return;

        const style = document.createElement('style');
        style.id = 'notification-styles';
    }

    // Shows notification in the browser UI layer.
    showNotification(message, type = 'info', group = 'default', duration = 3000) {
        if (this.notificationTimers.has(group)) {
            clearTimeout(this.notificationTimers.get(group));
            this.notificationTimers.delete(group);
        }

        if (this.activeNotifications.has(group)) {
            const existing = document.querySelector(`[data-notification-group="${group}"]`);
            if (existing) {
                existing.remove();
                this.activeNotifications.delete(group);
            }
        }

        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        notification.setAttribute('data-notification-group', group);

        notification.style.transform = 'translateX(100%)';
        notification.style.opacity = '0';
        notification.style.transition = 'all 0.3s ease';

        document.body.appendChild(notification);
        this.activeNotifications.add(group);

        requestAnimationFrame(() => {
            notification.style.transform = 'translateX(0)';
            notification.style.opacity = '1';
        });

        const timer = setTimeout(() => {
            this.hideNotification(notification, group);
        }, duration);

        this.notificationTimers.set(group, timer);
    }

    // Hides notification in the browser UI layer.
    hideNotification(notification, group) {
        notification.style.transform = 'translateX(100%)';
        notification.style.opacity = '0';

        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
            this.activeNotifications.delete(group);
            this.notificationTimers.delete(group);
        }, 300);
    }

    // Handles quick notify in the browser UI layer.
    quickNotify(message, type = 'info', group = 'default') {
        this.showNotification(message, type, group, 2000);
    }

    // Handles clear all in the browser UI layer.
    clearAll() {
        document.querySelectorAll('.notification').forEach(notification => {
            notification.remove();
        });
        this.activeNotifications.clear();
        this.notificationTimers.forEach(timer => clearTimeout(timer));
        this.notificationTimers.clear();
    }
}

export const notificationManager = new NotificationManager();
