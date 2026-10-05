// Web push on this device, in the browser: the service worker
// (public/sw.js), the browser's push subscription and the server's copy
// of it (POST/DELETE /api/push/subscribe). Pure helpers first (tested),
// then the browser calls the shell and Settings use.

export const SERVICE_WORKER_URL = "/sw.js";

// iPhone or iPad. iPadOS asks for the desktop site by default and then
// reports itself as a Mac, which has no touch screen.
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) {
    return true;
  }
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export type DevicePushKind = "ready" | "install-first" | "unsupported";

// ready: this browser can subscribe now. install-first: an iPhone or iPad
// in Safari, where push reaches only an app added to the home screen.
// unsupported: no push in this browser.
export function devicePushKind(device: {
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  ios: boolean;
  standalone: boolean;
}): DevicePushKind {
  if (device.ios && !device.standalone) {
    return "install-first";
  }
  return device.serviceWorker && device.pushManager && device.notification ? "ready" : "unsupported";
}

// The applicationServerKey bytes from the base64url key text.
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

export function currentDevicePushKind(): DevicePushKind {
  return devicePushKind({
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    ios: isIosDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    standalone: isStandalone(),
  });
}

export function shouldShowInstallHint(): boolean {
  return isIosDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0) && !isStandalone();
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
  } catch {
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await registerServiceWorker();
  if (!registration || !("pushManager" in registration)) {
    return null;
  }
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

async function postSubscription(subscription: PushSubscription): Promise<boolean> {
  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  return response.ok;
}

let synced = false;

// Once per page load, after the shell mounts: registers the service worker
// and, when this browser already has a push subscription, sends it to the
// server again, so it belongs to whoever is signed in here now (a shared
// device) and records this host. Never throws.
export async function syncDevicePush(): Promise<void> {
  if (synced) {
    return;
  }
  synced = true;
  try {
    const registration = await registerServiceWorker();
    if (!registration || !("Notification" in window) || Notification.permission !== "granted") {
      return;
    }
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await postSubscription(subscription);
    }
  } catch {
    // The next page load tries again.
  }
}

export type EnableResult = { ok: true } | { ok: false; reason: "denied" | "not-set-up" | "failed"; message: string };

// Asks for permission, subscribes this browser with the server's VAPID key
// and stores the subscription for the signed-in person.
export async function enableDevicePush(): Promise<EnableResult> {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return {
        ok: false,
        reason: "denied",
        message: "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
      };
    }
    const keyResponse = await fetch("/api/push/key", { cache: "no-store" });
    if (!keyResponse.ok) {
      return keyResponse.status === 503
        ? { ok: false, reason: "not-set-up", message: "Push notifications are not set up yet. Ask your platform admin." }
        : { ok: false, reason: "failed", message: "Could not turn on push. Reload the page and try again." };
    }
    const { publicKey } = (await keyResponse.json()) as { publicKey: string };
    const registration = await registerServiceWorker();
    if (!registration) {
      return { ok: false, reason: "failed", message: "This browser could not start notifications. Try again." };
    }
    await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }));
    if (!(await postSubscription(subscription))) {
      return { ok: false, reason: "failed", message: "This device could not be saved. Try again." };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed", message: "Could not turn on push. Check your connection and try again." };
  }
}

// This browser's subscription without registering anything first (for
// signing out, where no service worker may have been set up).
async function existingSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

// Stops push to this browser: the server forgets it, then the browser.
export async function disableDevicePush(): Promise<boolean> {
  try {
    const subscription = await existingSubscription();
    if (!subscription) {
      return true;
    }
    const response = await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    if (!response.ok && response.status !== 404) {
      return false;
    }
    await subscription.unsubscribe();
    return true;
  } catch {
    return false;
  }
}
