import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

// public/sw.js runs in the browser's service worker scope; here it runs in
// a separate VM context whose `self` is a stand-in that records what the
// worker does.
const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public/sw.js"), "utf8");

type Handler = (event: Record<string, unknown>) => void;
type FakeWindow = { url: string; focus: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn> };

function load(origin = "https://orders.impactrentals.store") {
  const handlers: Record<string, Handler> = {};
  const windows: FakeWindow[] = [];
  const self = {
    location: { origin },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
  };
  runInNewContext(code, { self, URL });
  return { handlers, self, windows };
}

function fire(handler: Handler, extra: Record<string, unknown>) {
  const waits: Promise<unknown>[] = [];
  handler({ ...extra, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
  return Promise.all(waits);
}

function pushData(value: unknown) {
  return {
    json: () => (typeof value === "string" ? JSON.parse(value) : value),
  };
}

function click(url: unknown) {
  return { notification: { close: vi.fn(), data: { url } } };
}

function windowAt(url: string, controlled = true): FakeWindow {
  const win: FakeWindow = { url, focus: vi.fn(async () => win) };
  if (controlled) {
    win.navigate = vi.fn(async (to: string) => ({ ...win, url: to }));
  }
  return win;
}

describe("service worker push", () => {
  it("shows the notice from the push message, linked to its order", async () => {
    const { handlers, self } = load();
    await fire(handlers.push, {
      data: pushData({ title: "New order #1001", body: "Riley, CA$120.00", url: "https://orders.impactrentals.store/?order=o1", tag: "order-o1" }),
    });
    expect(self.registration.showNotification).toHaveBeenCalledWith("New order #1001", {
      body: "Riley, CA$120.00",
      icon: "/app-icon/192.png",
      tag: "order-o1",
      data: { url: "https://orders.impactrentals.store/?order=o1" },
    });
  });

  it("still shows a plain notification for a message it cannot read", async () => {
    const { handlers, self } = load();
    await fire(handlers.push, { data: pushData("{not json") });
    await fire(handlers.push, { data: null });
    for (const call of self.registration.showNotification.mock.calls as unknown as Array<[string, { data: { url: string } }]>) {
      expect(call[0]).toBe("New activity");
      expect(call[1].data.url).toBe("https://orders.impactrentals.store/");
    }
    expect(self.registration.showNotification).toHaveBeenCalledTimes(2);
  });

  it("takes over open pages as soon as it activates", async () => {
    const { handlers, self } = load();
    handlers.install({});
    expect(self.skipWaiting).toHaveBeenCalled();
    await fire(handlers.activate, {});
    expect(self.clients.claim).toHaveBeenCalled();
  });
});

describe("service worker notification click", () => {
  it("focuses a window already on the order", async () => {
    const { handlers, self, windows } = load();
    const onOrder = windowAt("https://orders.impactrentals.store/?order=o1");
    windows.push(windowAt("https://orders.impactrentals.store/settings"), onOrder);
    const event = click("https://orders.impactrentals.store/?order=o1");
    await fire(handlers.notificationclick, event);
    expect(event.notification.close).toHaveBeenCalled();
    expect(onOrder.focus).toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("brings an open window of the app to the order", async () => {
    const { handlers, self, windows } = load();
    const open = windowAt("https://orders.impactrentals.store/settings");
    windows.push(open);
    await fire(handlers.notificationclick, click("https://orders.impactrentals.store/?order=o1"));
    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith("https://orders.impactrentals.store/?order=o1");
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window when the app is not open, or cannot be navigated", async () => {
    const { handlers, self, windows } = load();
    await fire(handlers.notificationclick, click("https://orders.impactrentals.store/?order=o1"));
    expect(self.clients.openWindow).toHaveBeenLastCalledWith("https://orders.impactrentals.store/?order=o1");
    windows.push(windowAt("https://orders.impactrentals.store/", false));
    await fire(handlers.notificationclick, click("https://orders.impactrentals.store/?order=o2"));
    expect(self.clients.openWindow).toHaveBeenLastCalledWith("https://orders.impactrentals.store/?order=o2");
  });

  it("opens a link on another host in a new window", async () => {
    const { handlers, self, windows } = load("https://orderingdesk.com");
    windows.push(windowAt("https://orderingdesk.com/"));
    await fire(handlers.notificationclick, click("https://orders.impactrentals.store/?order=o1"));
    expect(self.clients.openWindow).toHaveBeenCalledWith("https://orders.impactrentals.store/?order=o1");
  });

  it("never opens a script link", async () => {
    const { handlers, self } = load();
    await fire(handlers.notificationclick, click("javascript:alert(1)"));
    expect(self.clients.openWindow).toHaveBeenCalledWith("https://orders.impactrentals.store/");
  });
});
