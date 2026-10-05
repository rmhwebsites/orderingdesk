import { describe, it, expect } from "vitest";
import { base64UrlToBytes, devicePushKind, isIosDevice } from "./push-client";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_MODE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

describe("isIosDevice", () => {
  it("knows iPhones and iPads, including an iPad asking for the desktop site", () => {
    expect(isIosDevice(IPHONE, 5)).toBe(true);
    expect(isIosDevice(IPAD_DESKTOP_MODE, 5)).toBe(true);
    expect(isIosDevice(IPAD_DESKTOP_MODE, 0)).toBe(false);
    expect(isIosDevice(ANDROID, 5)).toBe(false);
  });
});

describe("devicePushKind", () => {
  const supported = { serviceWorker: true, pushManager: true, notification: true };

  it("is ready where the browser has everything push needs", () => {
    expect(devicePushKind({ ...supported, ios: false, standalone: false })).toBe("ready");
    expect(devicePushKind({ ...supported, ios: true, standalone: true })).toBe("ready");
  });

  it("asks iPhone users to install first: iOS only delivers push to an installed app", () => {
    expect(devicePushKind({ ...supported, ios: true, standalone: false })).toBe("install-first");
    expect(devicePushKind({ serviceWorker: true, pushManager: false, notification: false, ios: true, standalone: false })).toBe(
      "install-first",
    );
  });

  it("is unsupported elsewhere without push", () => {
    expect(devicePushKind({ serviceWorker: true, pushManager: false, notification: true, ios: false, standalone: false })).toBe(
      "unsupported",
    );
  });
});

describe("base64UrlToBytes", () => {
  it("decodes the VAPID key text browsers subscribe with", () => {
    expect([...base64UrlToBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
    expect([...base64UrlToBytes("AQID")]).toEqual([1, 2, 3]);
  });
});
