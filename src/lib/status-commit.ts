// When the desk's status control (src/components/desk/status-select.tsx)
// saves. It is a native select, and on Windows and Linux arrowing through
// a closed select (or typing ahead) fires change on every step, so saving
// on change would save, broadcast and timeline every status passed
// through, and pass through statuses that start purchase orders or
// fulfill in Shopify. So:
// - a change made with the keyboard is staged, and saved on Enter or when
//   focus leaves the control; Escape drops it;
// - a pointer or touch pick (a mouse choice from the open list, a phone
//   picker) saves at once;
// - the status the order already has is never saved again, and nothing is
//   saved while a change for the order is still in flight.
// Pure, so the rules are tested without a browser.

export type StatusInputState = {
  // The status chosen with the keyboard and not saved yet.
  staged: string | null;
  // Whether the last interaction with the control was the keyboard.
  keyboard: boolean;
};

export const IDLE_STATUS_INPUT: StatusInputState = { staged: null, keyboard: false };

export type StatusInput =
  | { kind: "pointer" }
  | { kind: "key"; key: string }
  | { kind: "change"; value: string }
  | { kind: "blur" };

export type StatusInputStep = {
  state: StatusInputState;
  // The status to save now, or null.
  commit: string | null;
  // The key was consumed (the caller prevents its default and stops it).
  handled: boolean;
};

export function statusInput(
  state: StatusInputState,
  input: StatusInput,
  committed: string,
  busy: boolean,
): StatusInputStep {
  const save = (value: string | null, next: StatusInputState): StatusInputStep => ({
    state: next,
    commit: value !== null && value !== committed && !busy ? value : null,
    handled: false,
  });
  switch (input.kind) {
    case "pointer":
      return { state: { ...state, keyboard: false }, commit: null, handled: false };
    case "key":
      if (input.key === "Enter" && state.staged !== null) {
        return { ...save(state.staged, { staged: null, keyboard: true }), handled: true };
      }
      if (input.key === "Escape" && state.staged !== null) {
        return { state: { staged: null, keyboard: true }, commit: null, handled: true };
      }
      return { state: { ...state, keyboard: true }, commit: null, handled: false };
    case "change":
      if (state.keyboard) {
        return {
          state: { staged: input.value === committed ? null : input.value, keyboard: true },
          commit: null,
          handled: false,
        };
      }
      return save(input.value, { staged: null, keyboard: false });
    case "blur":
      return save(state.staged, { staged: null, keyboard: false });
  }
}
