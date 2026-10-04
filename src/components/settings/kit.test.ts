import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmStep, nearestRowOrder, SettingsSection } from "./kit";

describe("SettingsSection", () => {
  // The workspace header is two rows (109px) below lg and one row (61px)
  // from lg: a section opened from the section links must land below it.
  it("keeps its heading clear of the two-row header up to lg, tablets included", () => {
    const html = renderToStaticMarkup(createElement(SettingsSection, { id: "team", title: "Team", description: "Who", children: null }));
    const classes = (html.match(/<section[^>]*class="([^"]*)"/)?.[1] ?? "").split(" ");
    expect(classes).toContain("scroll-mt-32");
    expect(classes).toContain("lg:scroll-mt-24");
    expect(classes).not.toContain("sm:scroll-mt-24");
  });
});

describe("ConfirmStep", () => {
  it("describes its confirm button with the question, so a screen reader says what is confirmed", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmStep, {
        message: "Remove jo@example.com from this workspace?",
        confirmLabel: "Remove",
        busyLabel: "Removing",
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
        returnFocus: () => null,
      }),
    );
    const messageId = html.match(/<p id="([^"]+)"[^>]*>Remove jo@example.com from this workspace\?<\/p>/)?.[1];
    expect(messageId).toBeTruthy();
    const confirm = html.match(/<button[^>]*>Remove<\/button>/)?.[0] ?? "";
    expect(confirm).toContain(`aria-describedby="${messageId}"`);
  });
});

describe("nearestRowOrder", () => {
  // After a row is removed, focus goes to the row that took its place, then
  // the ones after it, then the ones before it (nearest first), skipping
  // rows with nothing to focus.
  it("tries the row now at the removed index, then later rows, then earlier ones nearest first", () => {
    expect(nearestRowOrder(5, 2)).toEqual([2, 3, 4, 1, 0]);
    expect(nearestRowOrder(3, 3)).toEqual([2, 1, 0]);
    expect(nearestRowOrder(2, 0)).toEqual([0, 1]);
    expect(nearestRowOrder(0, 0)).toEqual([]);
  });
});
