import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import type { SettingsPageData } from "@/server/settings-page";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The settings pages by host and role, for real against an in-memory
// database; the request context is stood in and redirect / notFound throw
// markers the way Next's do.
const state: { db: Db | null; host: string; session: { user: { id: string; email: string } } | null } = {
  db: null,
  host: "orderingdesk.test",
  session: null,
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com" },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async (resolution: { kind: string }) =>
    resolution.kind === "unknown" ? null : { api: { getSession: async () => state.session } },
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { default: SlugSettings } = await import("./page");
const { default: HostSettings } = await import("../../../settings/page");
const { SettingsPage } = await import("@/components/settings/settings-page");
const { WorkspaceShell } = await import("@/components/shell/workspace-shell");

const CLIENT_HOST = "orders.impactrentals.store";

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_other");
  await db
    .update(schema.workspaces)
    .set({ customDomain: CLIENT_HOST, customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_lead", "lead@example.com");
  await seedUser(db, "u_out", "out@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_impact", "u_lead", "manager");
  await seedMember(db, "ws_other", "u_out", "manager");
});

async function outcome(render: () => Promise<unknown>): Promise<string | ReactElement> {
  try {
    const element = await render();
    if (!isValidElement(element)) {
      throw new Error("expected an element");
    }
    return element;
  } catch (e) {
    if (e instanceof Error && (e.message.startsWith("REDIRECT") || e.message === "NOT_FOUND")) {
      return e.message;
    }
    throw e;
  }
}

const slugPage = (slug: string) => () => SlugSettings({ params: Promise.resolve({ slug }) });
const as = (id: string, email: string) => {
  state.session = { user: { id, email } };
};

describe("/w/[slug]/settings on the hub", () => {
  it("sends a signed-out visitor to sign in and answers a non-member with not found", async () => {
    expect(await outcome(slugPage("ws_impact"))).toBe("REDIRECT /sign-in");
    as("u_out", "out@example.com");
    expect(await outcome(slugPage("ws_impact"))).toBe("NOT_FOUND");
    expect(await outcome(slugPage("missing"))).toBe("NOT_FOUND");
  });

  it("shows each role its own sections", async () => {
    as("u_staff", "staff@example.com");
    const staff = (await outcome(slugPage("ws_impact"))) as ReactElement<{ data: SettingsPageData }>;
    expect(staff.type).toBe(SettingsPage);
    expect(staff.props.data.access.sections).toEqual(["alerts", "store", "ai", "vendors"]);
    expect(staff.props.data.team).toBeNull();
    expect(staff.props.data.workspace.basePath).toBe("/w/ws_impact");

    as("u_lead", "lead@example.com");
    const manager = (await outcome(slugPage("ws_impact"))) as ReactElement<{ data: SettingsPageData }>;
    expect(manager.props.data.access.sections).toEqual(["alerts", "store", "ai", "team", "statuses", "search", "vendors", "notifications"]);

    as("u_boss", "boss@example.com");
    const platform = (await outcome(slugPage("ws_other"))) as ReactElement<{ data: SettingsPageData }>;
    expect(platform.props.data.role).toBe("platform");
    expect(platform.props.data.access.sections).toContain("branding");
  });

  it("sends a client host's own slug to its /settings and hides other workspaces there", async () => {
    state.host = CLIENT_HOST;
    as("u_staff", "staff@example.com");
    expect(await outcome(slugPage("ws_impact"))).toBe("REDIRECT /settings");
    expect(await outcome(slugPage("ws_other"))).toBe("NOT_FOUND");
  });
});

describe("/settings", () => {
  it("is the workspace's settings on its client host, in the client host shell", async () => {
    state.host = CLIENT_HOST;
    expect(await outcome(() => HostSettings())).toBe("REDIRECT /sign-in");
    as("u_out", "out@example.com");
    expect(await outcome(() => HostSettings())).toBe("NOT_FOUND");
    as("u_lead", "lead@example.com");
    const element = (await outcome(() => HostSettings())) as ReactElement<{
      clientHost: boolean;
      children: ReactElement<{ data: SettingsPageData }>;
    }>;
    expect(element.type).toBe(WorkspaceShell);
    expect(element.props.clientHost).toBe(true);
    expect(element.props.children.type).toBe(SettingsPage);
    expect(element.props.children.props.data.workspace.basePath).toBe("");
    expect(element.props.children.props.data.role).toBe("manager");
  });

  it("does not exist on the hub or an unknown host", async () => {
    as("u_boss", "boss@example.com");
    expect(await outcome(() => HostSettings())).toBe("NOT_FOUND");
    state.host = "evil.example";
    expect(await outcome(() => HostSettings())).toBe("NOT_FOUND");
  });
});
