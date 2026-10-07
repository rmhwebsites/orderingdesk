// "Via AI" (comprehensive desk design section 4): a change a person makes
// through their AI app is their own change, written with source "ai" and
// the app in meta.ai.client, so the timeline and the bell can say "via
// Claude". The app comes from a fixed list picked on the server from the
// connection's verified domain or redirect host (src/mcp/oauth/
// client-policy.ts), never from a name the app chose for itself. Pure.
// Relative imports only: custom-worker.ts bundles this through the desk
// services.

export const AI_CLIENTS = ["claude", "claude-code", "chatgpt", "other"] as const;
export type AiClient = (typeof AI_CLIENTS)[number];

// What a desk service needs to know about a change made through an AI app.
export type Via = { client: AiClient };

const LABELS: Record<AiClient, string> = {
  claude: "Claude",
  "claude-code": "Claude Code",
  chatgpt: "ChatGPT",
  other: "an AI app",
};

export function isAiClient(value: unknown): value is AiClient {
  return typeof value === "string" && (AI_CLIENTS as readonly string[]).includes(value);
}

export function aiClientLabel(client: unknown): string {
  return isAiClient(client) ? LABELS[client] : LABELS.other;
}

// An event's source: "ai" for a change made through an AI app.
export function eventSource(via: Via | undefined): "app" | "ai" {
  return via ? "ai" : "app";
}

// An event's meta with the app added, or unchanged without one.
export function withVia(meta: Record<string, unknown> | null, via: Via | undefined): Record<string, unknown> | null {
  return via ? { ...(meta ?? {}), ai: { client: via.client } } : meta;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// "via Claude" for an entry written through an AI app, else null.
export function viaLabel(event: { source?: string | null; meta?: unknown }): string | null {
  if (event.source !== "ai") {
    return null;
  }
  return `via ${aiClientLabel(record(record(event.meta).ai).client)}`;
}
