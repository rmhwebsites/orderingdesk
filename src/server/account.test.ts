import { describe, it, expect } from "vitest";
import { workspaceAccountView } from "./account";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "./desk/test-helpers";

const env = { APP_URL: "https://orderingdesk.test" } as CloudflareEnv;

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_a");
  await seedWorkspace(db, "ws_b");
  await seedUser(db, "u_one", "one@example.com", "Casey Lin");
  await seedUser(db, "u_two", "two@example.com", "");
  await seedMember(db, "ws_a", "u_one", "staff");
  await seedMember(db, "ws_a", "u_two", "manager");
  await seedMember(db, "ws_b", "u_two", "staff");
  return db;
}

describe("workspaceAccountView", () => {
  it("names the person and their role, with nowhere to switch when they have one workspace", async () => {
    const db = await setup();
    const viewer = { userId: "u_one", email: "one@example.com", platformAdmin: false };
    expect(await workspaceAccountView(db, env, { viewer, name: " Casey Lin ", role: "staff", clientHost: false })).toEqual({
      name: "Casey Lin",
      email: "one@example.com",
      roleLabel: "Staff",
      switchHref: null,
      links: [],
    });
  });

  it("sends someone with several workspaces to the list, on the hub and from a client host", async () => {
    const db = await setup();
    const viewer = { userId: "u_two", email: "two@example.com", platformAdmin: false };
    const hub = await workspaceAccountView(db, env, { viewer, name: "", role: "manager", clientHost: false });
    expect(hub.name).toBeNull();
    expect(hub.switchHref).toBe("/");
    const client = await workspaceAccountView(db, env, { viewer, name: "", role: "manager", clientHost: true });
    expect(client.switchHref).toBe("https://orderingdesk.test/");
  });

  it("always offers a platform admin the list", async () => {
    const db = await setup();
    const viewer = { userId: "u_boss", email: "boss@example.com", platformAdmin: true };
    const view = await workspaceAccountView(db, env, { viewer, name: "Boss", role: "platform", clientHost: false });
    expect(view.switchHref).toBe("/");
    expect(view.roleLabel).toBe("Platform admin");
  });
});
