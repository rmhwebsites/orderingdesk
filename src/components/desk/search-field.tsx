"use client";

import { useEffect, useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { Spinner } from "@/components/kit";
import { ui } from "@/components/ui";

export function matchLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "card" : "cards"}`;
}

// The desk's one search box (design section 3). Words filter as you type
// (the desk debounces onChange into the URL) and search every card, open
// and closed (owner decision); Enter submits, and a question of three words
// or more goes to AI search. resetKey changes when the desk rewrites the
// words itself (Enter, the clear button, Clear filters, AI search
// understood the question, the address changed outside the box): the box
// then shows value again. Otherwise the box keeps what is being typed, so a
// slow URL update never eats a keystroke.
export function DeskSearchField({
  value,
  resetKey,
  onChange,
  onSubmit,
  asking,
  aiHint,
  inputRef,
  className = "min-w-0 flex-1 sm:max-w-md",
}: {
  value: string;
  resetKey: number;
  onChange: (text: string) => void;
  onSubmit: (text: string) => void;
  asking: boolean;
  aiHint: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  className?: string;
}) {
  const [text, setText] = useState(value);
  // Only an explicit reset replaces what is typed.
  useEffect(() => {
    setText(value);
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form
      role="search"
      className={`relative ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(text);
      }}
    >
      <label htmlFor="desk-search" className="sr-only">
        Search orders and requests
      </label>
      <MagnifyingGlassIcon
        size={16}
        aria-hidden
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
      />
      <input
        ref={inputRef}
        id="desk-search"
        type="search"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(event.target.value);
        }}
        placeholder={aiHint ? "Search or ask a question" : "Search order, request, name or item"}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        aria-busy={asking || undefined}
        aria-describedby={aiHint ? "desk-search-hint" : undefined}
        className={`${ui.input} pl-10 ${asking ? "pr-10" : ""}`}
      />
      {aiHint ? (
        <span id="desk-search-hint" className="sr-only">
          Type words to filter, or ask a question and press Enter.
        </span>
      ) : null}
      {asking ? (
        <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-2">
          <Spinner />
          <span className="sr-only">Asking AI search</span>
        </span>
      ) : null}
    </form>
  );
}
