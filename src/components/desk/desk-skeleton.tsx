// Loading placeholders shaped like the real desk: the toolbar row, then
// 44px table rows (880px and up) or compact cards (below).

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`od-skeleton block ${className}`} />;
}

export function DeskSkeleton() {
  return (
    <div role="status" aria-label="Loading orders" className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Bar className="h-10 flex-1 desk:w-52 desk:flex-none" />
        <Bar className="h-10 w-10 desk:hidden" />
        <Bar className="h-10 w-10 desk:hidden" />
        <Bar className="h-10 w-72 max-desk:hidden" />
        <Bar className="h-10 w-44 max-desk:hidden desk:ml-auto" />
      </div>

      <div className="hidden overflow-hidden rounded-panel border border-line bg-surface desk:block">
        <div className="flex h-9 items-center gap-6 px-4">
          {["w-12", "w-10", "w-16", "w-12"].map((width, i) => (
            <Bar key={i} className={`h-3 ${width}`} />
          ))}
        </div>
        {ROWS.map((row) => (
          <div key={row} className="grid h-11 grid-cols-[3.5rem_10rem_6.5rem_24%_1fr_5.5rem_9rem_11rem] items-center border-t border-line">
            <div className="pl-4">
              <Bar className="size-4" />
            </div>
            <div className="px-2">
              <Bar className="h-4 w-20" />
            </div>
            <div className="px-3">
              <Bar className="h-3.5 w-14" />
            </div>
            <div className="px-3">
              <Bar className="h-3.5 w-40" />
            </div>
            <div className="px-3">
              <Bar className="h-3.5 w-11/12" />
            </div>
            <div className="px-3">
              <Bar className="h-5 w-10" />
            </div>
            <div className="px-3">
              <Bar className="h-3.5 w-20" />
            </div>
            <div className="px-4">
              <Bar className="h-8 w-28" />
            </div>
          </div>
        ))}
      </div>

      <ul className="flex flex-col gap-2 desk:hidden">
        {ROWS.slice(0, 5).map((row) => (
          <li key={row} className="rounded-panel border border-line bg-surface px-3.5 py-3">
            <div className="flex justify-between">
              <Bar className="h-4 w-20" />
              <Bar className="h-3.5 w-12" />
            </div>
            <Bar className="mt-2 h-3.5 w-48" />
            <Bar className="mt-1.5 h-3.5 w-56" />
            <Bar className="mt-3 h-8 w-28" />
          </li>
        ))}
      </ul>
      <span className="sr-only">Loading orders</span>
    </div>
  );
}
