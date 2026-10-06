// How long a card has waited in its status (comprehensive desk design
// section 1): "12m", "5h" or "2d" since status_set_at, else since it
// arrived; amber and red past the workspace's thresholds (Settings >
// Statuses). A closed card shows its age without a warning color. Pure, so
// the rules are tested; the desk list renders it.

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type AgeTone = "none" | "amber" | "red";

export type CardAge = {
  short: string;
  // "2 days", for screen readers.
  long: string;
  tone: AgeTone;
  // When the wait started.
  since: number;
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function cardAge(
  card: { statusSetAt: number | null; createdAt: number },
  now: number,
  rule: { amberDays: number; redDays: number; closed: boolean },
): CardAge {
  const since = card.statusSetAt ?? card.createdAt;
  const elapsed = Math.max(0, now - since);
  let short: string;
  let long: string;
  if (elapsed < HOUR) {
    const minutes = Math.max(1, Math.floor(elapsed / MINUTE));
    short = `${minutes}m`;
    long = plural(minutes, "minute");
  } else if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    short = `${hours}h`;
    long = plural(hours, "hour");
  } else {
    const days = Math.floor(elapsed / DAY);
    short = `${days}d`;
    long = plural(days, "day");
  }
  const tone: AgeTone = rule.closed
    ? "none"
    : elapsed >= rule.redDays * DAY
      ? "red"
      : elapsed >= rule.amberDays * DAY
        ? "amber"
        : "none";
  return { short, long, tone, since };
}
