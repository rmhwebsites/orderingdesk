"use client";

import { useEffect, useState } from "react";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { MoonIcon } from "@phosphor-icons/react/Moon";
import { SunIcon } from "@phosphor-icons/react/Sun";
import { THEMES, applyTheme, readStoredTheme, storeTheme, type Theme } from "@/lib/theme";
import { Segmented } from "@/components/kit";

const LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Match system" };

const ICONS: Record<Theme, React.ReactNode> = {
  light: <SunIcon size={16} aria-hidden />,
  dark: <MoonIcon size={16} aria-hidden />,
  system: <DesktopIcon size={16} aria-hidden />,
};

// Three-state theme switch (light default, dark, system), the shared
// Segmented radio group. labels: show the words (the account menu); icons
// only otherwise, with the words for screen readers and as tooltips.
export function ThemeToggle({ labels = false }: { labels?: boolean }) {
  // Unknown until mounted: the server cannot see localStorage, and
  // theme-init.js has already applied the stored value to <html>.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  return (
    <Segmented
      name="theme"
      legend="Theme"
      size="sm"
      value={theme}
      options={THEMES.map((value) => ({ value, label: LABELS[value], icon: ICONS[value], iconOnly: !labels }))}
      onChange={(next) => {
        setTheme(next);
        applyTheme(next);
        storeTheme(next);
      }}
    />
  );
}
