import { describe, it, expect } from "vitest";
import { IDLE_STATUS_INPUT, statusInput, type StatusInput, type StatusInputState } from "./status-commit";

// The desk's status control is a native select. On Windows and Linux,
// arrowing through a closed select (or typing ahead) fires change on every
// step, so committing on change would save every status passed through.
// Keyboard changes are staged and committed on Enter or when focus leaves;
// a pointer or touch pick commits at once.

function run(inputs: StatusInput[], committed = "new", busy = false) {
  let state: StatusInputState = IDLE_STATUS_INPUT;
  const commits: string[] = [];
  const handled: boolean[] = [];
  for (const input of inputs) {
    const step = statusInput(state, input, committed, busy);
    state = step.state;
    handled.push(step.handled);
    if (step.commit !== null) {
      commits.push(step.commit);
    }
  }
  return { state, commits, handled };
}

const key = (name: string): StatusInput => ({ kind: "key", key: name });
const change = (value: string): StatusInput => ({ kind: "change", value });

describe("statusInput", () => {
  it("stages every keyboard step and commits once, on Enter, the status it stopped on", () => {
    const browsing = run([key("ArrowDown"), change("processing"), key("ArrowDown"), change("approved"), key("ArrowDown"), change("shipped")]);
    expect(browsing.commits).toEqual([]);
    expect(browsing.state.staged).toBe("shipped");
    const saved = run([key("ArrowDown"), change("processing"), key("ArrowDown"), change("shipped"), key("Enter")]);
    expect(saved.commits).toEqual(["shipped"]);
    expect(saved.state.staged).toBeNull();
    // Enter is consumed only when there was something to commit.
    expect(saved.handled.at(-1)).toBe(true);
    expect(run([key("Enter")]).handled).toEqual([false]);
  });

  it("commits a staged status when focus leaves the control", () => {
    expect(run([key("p"), change("processing"), { kind: "blur" }]).commits).toEqual(["processing"]);
    expect(run([{ kind: "blur" }]).commits).toEqual([]);
  });

  it("drops a staged status on Escape, consuming the key only then", () => {
    const dropped = run([key("ArrowDown"), change("processing"), key("Escape")]);
    expect(dropped.commits).toEqual([]);
    expect(dropped.state.staged).toBeNull();
    expect(dropped.handled.at(-1)).toBe(true);
    expect(run([key("Escape")]).handled).toEqual([false]);
  });

  it("commits a pointer or touch pick at once", () => {
    expect(run([{ kind: "pointer" }, change("approved")]).commits).toEqual(["approved"]);
    // A pick after keyboard browsing replaces the staged one.
    expect(run([key("ArrowDown"), change("processing"), { kind: "pointer" }, change("approved")]).commits).toEqual([
      "approved",
    ]);
  });

  it("never commits the status the order already has", () => {
    const back = run([key("ArrowDown"), change("processing"), key("ArrowUp"), change("new"), key("Enter")]);
    expect(back.commits).toEqual([]);
    expect(back.state.staged).toBeNull();
    expect(run([{ kind: "pointer" }, change("new")]).commits).toEqual([]);
  });

  it("commits nothing while a change for the order is still saving", () => {
    expect(run([{ kind: "pointer" }, change("approved")], "new", true).commits).toEqual([]);
    const staged = run([key("ArrowDown"), change("approved"), key("Enter")], "new", true);
    expect(staged.commits).toEqual([]);
    expect(staged.state.staged).toBeNull();
  });
});
