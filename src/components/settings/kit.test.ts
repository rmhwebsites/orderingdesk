import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { ConfirmStep, nearestRowOrder, SettingsSection, Switch } from "./kit";

// The first element of `type` in a rendered tree (host elements only).
function findElement(node: ReactNode, type: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return null;
  }
  return node.type === type ? node : findElement(node.props.children as ReactNode, type);
}

describe("Switch", () => {
  // Disabling the focused switch while its change saves would drop
  // keyboard focus to the page; a busy switch keeps focus and ignores
  // changes instead.
  it("stays focusable while busy: aria-disabled, never disabled", () => {
    const html = renderToStaticMarkup(
      createElement(Switch, { id: "alerts-push-orders", checked: true, onChange: () => {}, label: "Push", busy: true }),
    );
    const input = html.match(/<input[^>]*>/)?.[0] ?? "";
    expect(input).toContain('aria-disabled="true"');
    expect(input).not.toMatch(/\sdisabled=""/);
  });

  it("ignores changes while busy and passes them on otherwise", () => {
    const changes: boolean[] = [];
    const flip = (busy: boolean) => {
      const tree = Switch({ id: "s", checked: false, onChange: (value) => changes.push(value), label: "Push", busy });
      const input = findElement(tree, "input");
      (input?.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    };
    flip(true);
    expect(changes).toEqual([]);
    flip(false);
    expect(changes).toEqual([true]);
  });
});

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
