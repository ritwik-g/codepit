import type { SessionSummary } from './types';
import { isWorking, plainText } from './components/Sidebar';

// System notifications when a session needs the user: a turn finished, or the agent asks a
// question or wants an approval. Browsers only allow them in a secure context (the app,
// localhost); elsewhere this stays silent.

const PREF_KEY = 'codepit_notifications';

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;

export function notificationsEnabled(): boolean {
  return notificationsSupported() && localStorage.getItem(PREF_KEY) !== 'off' && Notification.permission !== 'denied';
}

/** Turn them on or off; turning them on asks the browser for permission when it has not been asked. */
export async function setNotificationsEnabled(on: boolean): Promise<boolean> {
  localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  if (on && notificationsSupported() && Notification.permission === 'default') {
    await Notification.requestPermission().catch(() => 'denied');
  }
  return notificationsEnabled();
}

/** Ask once, on the first click or key press: browsers refuse a request made without one. */
export function askForNotificationsOnFirstGesture(): void {
  if (!notificationsSupported() || Notification.permission !== 'default' || localStorage.getItem(PREF_KEY) === 'off') return;
  const ask = () => {
    window.removeEventListener('pointerdown', ask);
    window.removeEventListener('keydown', ask);
    Notification.requestPermission().catch(() => {});
  };
  window.addEventListener('pointerdown', ask, { once: true });
  window.addEventListener('keydown', ask, { once: true });
}

interface Alert {
  title: string;
  body: string;
  /** Replaces an earlier alert for the same session and reason. */
  tag: string;
}

/** What changed between two readings of a session that the user should hear about, if anything. */
export function sessionAlert(prev: SessionSummary | undefined, next: SessionSummary): Alert | null {
  if (!prev || next.user.cleanup) return null;
  const name = next.title || 'Session';
  const waitingBefore = prev.state === 'blocked';
  if (next.state === 'blocked' && (!waitingBefore || prev.pendingElicitationTitle !== next.pendingElicitationTitle || prev.pendingPermissionTitle !== next.pendingPermissionTitle)) {
    if (next.hasPendingElicitation && !next.hasPendingPermission) {
      return { title: `${name} asks you`, body: next.pendingElicitationTitle || 'The agent is waiting for your answer.', tag: `${next.id}:ask` };
    }
    return { title: `${name} needs approval`, body: next.pendingPermissionTitle || 'The agent is waiting for your approval.', tag: `${next.id}:ask` };
  }
  const finished = isWorking(prev) && next.state === 'needs_you' && !next.workingInBackground;
  if (finished) {
    return { title: `${name} finished`, body: plainText(next.recap).slice(0, 180) || 'Waiting for your reply.', tag: `${next.id}:done` };
  }
  if (next.state === 'crashed' && prev.state !== 'crashed') {
    return { title: `${name} crashed`, body: 'The agent stopped unexpectedly.', tag: `${next.id}:crash` };
  }
  return null;
}

/** Show one alert; clicking it brings the app forward and opens the session. */
export function showAlert(alert: Alert, onOpen: () => void): void {
  if (!notificationsEnabled() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(alert.title, { body: alert.body, tag: alert.tag, silent: false });
    n.onclick = () => {
      window.focus();
      onOpen();
      n.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; nothing to show then
  }
}
