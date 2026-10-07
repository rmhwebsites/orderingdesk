import { describe, it, expect } from "vitest";
import { call, principalFor, setupMcp, toolDeps } from "../test-helpers";
import { getMyAccess } from "./access";

describe("get_my_access", () => {
  it("names the person, and never by their email when they have no name", async () => {
    const db = await setupMcp();
    expect((await call(getMyAccess, {}, toolDeps(db))).data.you).toBe("Casey Lin");
    // The principal goes by the email when the account has no name.
    const nameless = await call(getMyAccess, {}, toolDeps(db, principalFor("manager", { personName: "casey.lin@example.com" })));
    expect(nameless.data.you).toBeNull();
    expect(JSON.stringify(nameless.data)).not.toContain("casey.lin@example.com");
  });
});
