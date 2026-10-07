"use client";

import { useState } from "react";
import type { SettingsView } from "@/server/desk/shapes";
import { Spinner } from "@/components/kit";
import { ui } from "@/components/ui";
import { describedBy, Field, InlineMessage, Panel, requestJson, SaveStatus, Select, SettingsSection, Switch } from "./kit";

// The zones a US or Canadian workspace is likely in; the saved zone is
// added when it is another one.
export const COMMON_TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Halifax",
  "America/Toronto",
  "America/Vancouver",
  "UTC",
];

type SearchSettings = Pick<SettingsView, "timeZone" | "aiSearch">;

// Settings > Search (managers and platform admins): the time zone search
// dates follow (today, last week, last month) and the AI search switch.
export function SearchSection({ workspaceId, initial }: { workspaceId: string; initial: SearchSettings }) {
  const [saved, setSaved] = useState<SearchSettings>({ timeZone: initial.timeZone, aiSearch: initial.aiSearch });
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [aiSearch, setAiSearch] = useState(initial.aiSearch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const zones = COMMON_TIME_ZONES.includes(saved.timeZone) ? COMMON_TIME_ZONES : [saved.timeZone, ...COMMON_TIME_ZONES];
  const dirty = timeZone !== saved.timeZone || aiSearch !== saved.aiSearch;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !dirty) {
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await requestJson<{ settings: SettingsView }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`, {
      method: "PUT",
      json: { timeZone, aiSearch },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const next = { timeZone: result.data.settings.timeZone, aiSearch: result.data.settings.aiSearch };
    setSaved(next);
    setTimeZone(next.timeZone);
    setAiSearch(next.aiSearch);
    setDone("Search settings saved.");
  }

  return (
    <SettingsSection
      id="search"
      title="Search"
      description="How the desk reads dates in searches like last week, and whether questions go to AI search."
    >
      <Panel>
        <form onSubmit={save} className="flex flex-col gap-5">
          <Field id="time-zone" label="Time zone" help="Today, last week and last month follow this time zone. Weeks start on Monday.">
            <Select
              id="time-zone"
              value={timeZone}
              onChange={(event) => {
                setTimeZone(event.target.value);
                setDone(null);
              }}
              aria-describedby={describedBy("time-zone", { help: true })}
              className="max-w-sm"
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.split("_").join(" ")}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-2">
            <Switch
              id="ai-search"
              checked={aiSearch}
              onChange={(checked) => {
                setAiSearch(checked);
                setDone(null);
              }}
              label="AI search"
              describedBy="ai-search-help"
            />
            <p id="ai-search-help" className="max-w-[65ch] text-sm text-ink-2">
              Questions of three words or more are read by Cloudflare Workers AI and turned into filters. It sees the question
              and your status, location and item names, never order details. Each person can ask 100 questions a day.
            </p>
          </div>
          {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <button type="submit" disabled={busy || !dirty} aria-busy={busy || undefined} className={ui.buttonPrimary}>
              {busy ? <Spinner /> : null}
              {busy ? "Saving" : "Save search settings"}
            </button>
            <SaveStatus text={done} />
          </div>
        </form>
      </Panel>
    </SettingsSection>
  );
}
