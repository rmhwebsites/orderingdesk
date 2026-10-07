// Workspace settings: the workspace's own name and accent color plus the
// workspace_settings row (notification list, PO prefix, email identity,
// search time zone and the AI search switch).

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch } from "@/db/batch";
import { workspaceSettings, workspaces } from "@/db/schema";
import { isTimeZone } from "@/lib/date-range";
import { isRecord, settingsView, type SettingsView } from "./shapes";
import { normalizeEmail, normalizeEmailList } from "./validate";

export const WORKSPACE_NAME_MAX = 80;
export const NOTIFICATION_EMAILS_MAX = 20;

// accentColor is rendered into inline styles, so this exact shape is the CSS
// injection guard: nothing but # and six hex digits reaches a style
// attribute. (JS $ without the m flag matches only at the very end, so a
// trailing newline fails too.)
const ACCENT_COLOR = /^#[0-9a-fA-F]{6}$/;
const PO_PREFIX = /^[A-Z0-9]{1,8}$/;
// fromName becomes the display name on outgoing email: ASCII letters,
// digits, spaces and . , ' & - only, so it can never break or extend an
// address header. ASCII on purpose; a non-ASCII display name needs header
// encoding downstream, which nothing has verified yet.
const FROM_NAME = /^[A-Za-z0-9 .,'&-]{1,60}$/;

export type SettingsPayload = {
  workspace: { name: string; accentColor: string; slug: string };
  settings: SettingsView;
};

export type UpdateSettingsResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  // A field the caller's role may not change (the route answers 404).
  | { kind: "forbidden" }
  | ({ kind: "ok" } & SettingsPayload);

// canEditIdentity: the workspace's name and accent color (its branding) are
// platform-admin settings (platform amendment section 2); managers change
// the notification list, reply-to, from name, PO prefix, time zone and AI
// search switch.
export type SettingsAccess = { canEditIdentity: boolean };

type WorkspacePatch = { name?: string; accentColor?: string };
type SettingsPatch = {
  notificationEmails?: string[];
  poPrefix?: string;
  replyTo?: string | null;
  fromName?: string | null;
  timeZone?: string;
  aiSearch?: boolean;
};

function blank(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.trim().length === 0);
}

// Validates every field present; any invalid field rejects the whole update.
function parsePatch(body: unknown): { workspace: WorkspacePatch; settings: SettingsPatch } | string {
  if (!isRecord(body)) {
    return "Send the settings as a JSON object";
  }
  const workspace: WorkspacePatch = {};
  const settings: SettingsPatch = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length === 0 || name.length > WORKSPACE_NAME_MAX) {
      return `The workspace name must be 1 to ${WORKSPACE_NAME_MAX} characters`;
    }
    workspace.name = name;
  }
  if (body.accentColor !== undefined) {
    if (typeof body.accentColor !== "string" || !ACCENT_COLOR.test(body.accentColor)) {
      return "The accent color must be a hex color like #91d500";
    }
    workspace.accentColor = body.accentColor.toLowerCase();
  }
  if (body.notificationEmails !== undefined) {
    const emails = normalizeEmailList(body.notificationEmails, NOTIFICATION_EMAILS_MAX);
    if (emails === null) {
      return `Notification emails take a list of up to ${NOTIFICATION_EMAILS_MAX} valid addresses`;
    }
    settings.notificationEmails = emails;
  }
  if (body.poPrefix !== undefined) {
    const prefix = typeof body.poPrefix === "string" ? body.poPrefix.trim().toUpperCase() : "";
    if (!PO_PREFIX.test(prefix)) {
      return "The PO prefix must be 1 to 8 letters or digits";
    }
    settings.poPrefix = prefix;
  }
  if (body.replyTo !== undefined) {
    if (blank(body.replyTo)) {
      settings.replyTo = null;
    } else {
      const email = normalizeEmail(body.replyTo);
      if (email === null) {
        return "Reply-to must be a valid email address, or empty";
      }
      settings.replyTo = email;
    }
  }
  if (body.fromName !== undefined) {
    if (blank(body.fromName)) {
      settings.fromName = null;
    } else {
      // Phone keyboards type curly apostrophes; store the plain one.
      const name =
        typeof body.fromName === "string" ? body.fromName.replace(/[‘’]/g, "'").trim() : "";
      if (!FROM_NAME.test(name)) {
        return "The from name must be up to 60 characters: letters, digits, spaces and . , ' & - only";
      }
      settings.fromName = name;
    }
  }

  if (body.timeZone !== undefined) {
    if (!isTimeZone(body.timeZone)) {
      return "The time zone must be an IANA name like America/New_York";
    }
    settings.timeZone = body.timeZone;
  }
  if (body.aiSearch !== undefined) {
    if (typeof body.aiSearch !== "boolean") {
      return "AI search must be on or off";
    }
    settings.aiSearch = body.aiSearch;
  }

  if (Object.keys(workspace).length + Object.keys(settings).length === 0) {
    return "Nothing to update: send name, accentColor, notificationEmails, poPrefix, replyTo, fromName, timeZone or aiSearch";
  }
  return { workspace, settings };
}

export async function getWorkspaceSettings(
  db: Db,
  workspaceId: string,
): Promise<SettingsPayload | null> {
  const [workspaceRows, settingsRows] = await Promise.all([
    db
      .select({ name: workspaces.name, accentColor: workspaces.accentColor, slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1),
    db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1),
  ]);
  const workspace = workspaceRows[0];
  if (!workspace) {
    return null;
  }
  return { workspace, settings: settingsView(settingsRows[0]) };
}

// Partial update: only the fields present change; any field the caller may
// not change refuses the whole update. The workspace row and the
// settings row are written in one batch; the slug never changes.
export async function updateWorkspaceSettings(
  db: Db,
  workspaceId: string,
  body: unknown,
  access: SettingsAccess,
): Promise<UpdateSettingsResult> {
  const patch = parsePatch(body);
  if (typeof patch === "string") {
    return { kind: "invalid", error: patch };
  }
  if (!access.canEditIdentity && Object.keys(patch.workspace).length > 0) {
    return { kind: "forbidden" };
  }
  const found = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (found.length === 0) {
    return { kind: "not-found" };
  }

  const statements: PromiseLike<unknown>[] = [];
  if (Object.keys(patch.workspace).length > 0) {
    statements.push(db.update(workspaces).set(patch.workspace).where(eq(workspaces.id, workspaceId)));
  }
  if (Object.keys(patch.settings).length > 0) {
    // Upsert: every workspace gets a settings row at creation, but a missing
    // one is recreated (column defaults fill the rest) rather than failing.
    statements.push(
      db
        .insert(workspaceSettings)
        .values({ workspaceId, ...patch.settings })
        .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: patch.settings }),
    );
  }
  await applyBatch(db, statements);

  const payload = await getWorkspaceSettings(db, workspaceId);
  return payload ? { kind: "ok", ...payload } : { kind: "not-found" };
}
