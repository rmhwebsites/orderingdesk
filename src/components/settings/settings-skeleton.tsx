// Loading placeholders shaped like Settings: the back link and title, the
// section list, then two panels. The hub's Settings loading.tsx shows it,
// inside the workspace layout's shell, while the page renders on the
// server. A client host has none: its page draws the shell itself, so a
// loading.tsx there would replace the top bar and the workspace's theme.

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`od-skeleton block ${className}`} />;
}

export function SettingsSkeleton() {
  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-5 sm:px-6 sm:pt-7">
      <div role="status" aria-label="Loading settings">
        <Bar className="h-9 w-24" />
        <Bar className="mt-2 h-8 w-40" />
        <Bar className="mt-2 h-4 w-72 max-w-full" />
        <div className="mt-6 grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
          <div className="flex gap-2 overflow-hidden lg:flex-col">
            {["w-32", "w-28", "w-20", "w-24", "w-20"].map((width, i) => (
              <Bar key={i} className={`h-9 shrink-0 ${width}`} />
            ))}
          </div>
          <div className="flex min-w-0 max-w-5xl flex-col gap-12">
            {[0, 1].map((section) => (
              <div key={section} className="flex flex-col gap-4">
                <Bar className="h-6 w-48" />
                <Bar className="h-4 w-96 max-w-full" />
                <div className="rounded-panel border border-line bg-surface p-5">
                  <Bar className="h-4 w-3/4" />
                  <Bar className="mt-3 h-10 w-full" />
                  <Bar className="mt-3 h-10 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <span className="sr-only">Loading settings</span>
      </div>
    </main>
  );
}
