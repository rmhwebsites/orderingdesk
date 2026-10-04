"use client";

import { useEffect, useState } from "react";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { MoonIcon } from "@phosphor-icons/react/Moon";
import { SunIcon } from "@phosphor-icons/react/Sun";
import { THEMES, applyTheme, readStoredTheme, storeTheme, type Theme } from "@/lib/theme";

const OPTIONS: Record<Theme, { label: string; Icon: typeof SunIcon }> = {
  light: { label: "Light", Icon: SunIcon },
  dark: { label: "Dark", Icon: MoonIcon },
  system: { label: "Match system", Icon: DesktopIcon },
};

// Three-state theme switch (light default, dark, system) as a native radio
// group, so arrow keys and screen readers work without extra code.
export function ThemeToggle() {
  // Unknown until mounted: the server cannot see localStorage, and
  // theme-init.js has already applied the stored value to <html>.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
    storeTheme(next);
  }

  return (
    <fieldset className="flex shrink-0 items-center rounded-control border border-line bg-surface-2 p-0.5">
      <legend className="sr-only">Theme</legend>
      {THEMES.map((value) => {
        const { label, Icon } = OPTIONS[value];
        const checked = theme === value;
        return (
          <label
            key={value}
            title={label}
            className={`relative grid size-8 cursor-pointer place-items-center rounded-control transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus ${
              checked ? "bg-surface text-ink shadow-panel" : "text-ink-2 hover:text-ink"
            }`}
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={checked}
              onChange={() => choose(value)}
              className="sr-only"
            />
            <Icon size={16} aria-hidden />
            <span className="sr-only">{label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
