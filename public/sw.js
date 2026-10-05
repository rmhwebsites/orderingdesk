// Ordering Desk service worker: shows web push notifications and opens
// their link. Registered from the workspace shell on every host (the hub
// and each client host have their own). It caches nothing and has no fetch
// handler: every page is live, signed-in data.
//
// A push message is JSON {title, body, url, tag} (src/server/push.ts).
// The link is the order inside its workspace on the host this browser
// subscribed on, so a click lands where the person is signed in.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

// An http or https link, resolved against this origin; anything else
// opens the app's start page.
function safeUrl(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.href;
    }
  } catch {
    // falls through
  }
  return new URL("/", self.location.origin).href;
}

function readNotice(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const notice = data && typeof data === "object" ? data : {};
  return {
    // Push must always show something, so an unreadable message still
    // gives a plain notification that opens the app.
    title: text(notice.title, 120) || "New activity",
    body: text(notice.body, 240),
    tag: text(notice.tag, 64),
    url: safeUrl(notice.url),
  };
}

self.addEventListener("push", (event) => {
  const notice = readNotice(event);
  const options = {
    body: notice.body,
    icon: "/app-icon/192.png",
    data: { url: notice.url },
  };
  if (notice.tag) {
    options.tag = notice.tag;
  }
  event.waitUntil(self.registration.showNotification(notice.title, options));
});

// Focus a window already showing the link, else bring an open window of
// this app to the link, else open a new one.
async function openLink(href) {
  const target = new URL(href);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (target.origin === self.location.origin) {
    const exact = windows.find((client) => client.url === href);
    if (exact) {
      return exact.focus();
    }
    const open = windows.find((client) => {
      try {
        return new URL(client.url).origin === target.origin;
      } catch {
        return false;
      }
    });
    if (open) {
      try {
        const focused = await open.focus();
        if (focused && typeof focused.navigate === "function") {
          const navigated = await focused.navigate(href);
          if (navigated) {
            return navigated;
          }
        }
      } catch {
        // An uncontrolled window cannot be navigated from here: open one.
      }
    }
  }
  return self.clients.openWindow(href);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openLink(safeUrl(data.url)));
});
