"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { ui } from "@/components/ui";

// The email form. The magic link comes back to this same host (better-auth
// runs per host), so a client host keeps its own session.
export function SignInForm() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "sending") {
      return;
    }
    setPhase("sending");
    setErrorMessage("");
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: "/",
    });
    if (error) {
      setPhase("error");
      setErrorMessage(error.message ?? "Could not send the sign-in link.");
    } else {
      setPhase("sent");
    }
  }

  if (phase === "sent") {
    return (
      <div className={`${ui.panel} p-4`} role="status">
        <p className="font-medium">Check your email</p>
        <p className="mt-1 text-sm text-ink-2">We sent a sign-in link to {email}. It expires in 5 minutes.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label className={ui.label} htmlFor="email">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@company.com"
        aria-invalid={phase === "error" ? true : undefined}
        aria-describedby={phase === "error" ? "sign-in-error" : undefined}
        className={ui.input}
      />
      <button type="submit" disabled={phase === "sending"} className={`${ui.buttonPrimary} mt-2`}>
        {phase === "sending" ? "Sending" : "Send sign-in link"}
      </button>
      {phase === "error" ? (
        <p id="sign-in-error" className={ui.errorText}>
          {errorMessage}
        </p>
      ) : null}
    </form>
  );
}
