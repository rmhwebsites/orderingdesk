"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ui } from "@/components/ui";
import { Spinner } from "@/components/kit";

export function NewWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || name.trim().length === 0) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (response.ok) {
        setName("");
        router.refresh();
      } else {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setErrorMessage(data?.error ?? "Could not create the workspace.");
      }
    } catch {
      setErrorMessage("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label htmlFor="new-workspace-name" className={ui.label}>
        Workspace name
      </label>
      <div className="flex gap-2">
        <input
          id="new-workspace-name"
          type="text"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="IMPACT Rentals"
          aria-invalid={errorMessage ? true : undefined}
          aria-describedby={errorMessage ? "new-workspace-error" : undefined}
          className={ui.input}
        />
        <button type="submit" disabled={busy} aria-busy={busy || undefined} className={ui.buttonPrimary}>
          {busy ? <Spinner /> : null}
          {busy ? "Creating" : "Create"}
        </button>
      </div>
      {errorMessage ? (
        <p id="new-workspace-error" className={ui.errorText}>
          {errorMessage}
        </p>
      ) : null}
    </form>
  );
}
