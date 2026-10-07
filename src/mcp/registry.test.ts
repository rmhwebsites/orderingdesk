import { describe, it, expect, vi } from "vitest";
import * as z from "zod";
import * as schema from "@/db/schema";
import { runTool, toolsFor } from "./registry";
import { CONFIRM_DESTRUCTIVE, READ, defineTool, fail, ok, type ToolDeps } from "./tools/define";
import { NOW, principalFor, setupMcp, testEnv } from "./test-helpers";

const lookup = defineTool({
  name: "lookup",
  title: "Lookup",
  description: "A read.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: z.object({ q: z.string() }).strict(),
  run: async (args) => ok({ echo: args.q }, { kind: "order", id: "o1" }),
});
const managerWrite = defineTool({
  name: "confirm_thing",
  title: "Confirm thing",
  description: "A manager write.",
  minRole: "manager",
  needsWrite: true,
  counts: "self",
  annotations: CONFIRM_DESTRUCTIVE,
  input: z.object({}).strict(),
  run: async () => fail("refused", "No."),
});
const staffWrite = defineTool({ ...managerWrite, name: "confirm_note", minRole: "staff" });

describe("toolsFor", () => {
  it("lists tools by live role and by the scopes the person granted", () => {
    const all = [lookup, managerWrite, staffWrite];
    expect(toolsFor(principalFor("staff"), all).map((tool) => tool.name)).toEqual(["lookup", "confirm_note"]);
    expect(toolsFor(principalFor("manager"), all).map((tool) => tool.name)).toEqual(["lookup", "confirm_thing", "confirm_note"]);
    expect(toolsFor(principalFor("platform"), all)).toHaveLength(3);
    expect(toolsFor(principalFor("manager", { scopes: ["desk.read"] }), all).map((tool) => tool.name)).toEqual(["lookup"]);
  });
});

describe("runTool", () => {
  async function deps(overrides: Partial<ToolDeps> = {}): Promise<ToolDeps> {
    return { db: await setupMcp(), env: testEnv(), principal: principalFor(), now: () => NOW, after: () => undefined, ...overrides };
  }

  it("counts a lookup, runs the tool and audits the outcome with its target", async () => {
    const d = await deps();
    expect(await runTool(lookup, { q: "x" }, d)).toEqual({
      content: [{ type: "text", text: '{"echo":"x"}' }],
      structuredContent: { echo: "x" },
    });
    const audit = await d.db.select().from(schema.auditLog);
    expect(audit.map((row) => [row.tool, row.outcome, row.targetKind, row.targetId])).toEqual([["lookup", "ok", "order", "o1"]]);
    const usage = await d.db.select().from(schema.aiUsage);
    expect(usage.map((row) => [row.kind, row.count])).toEqual([["mcp_read", 1]]);
  });

  it("refuses a lookup over the daily limit, and audits it", async () => {
    const d = await deps({ principal: principalFor("staff", { limits: { reads: 0, changes: 0 } }) });
    const result = await runTool(lookup, { q: "x" }, d);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "limit_reached" } });
    expect((await d.db.select().from(schema.auditLog)).map((row) => row.outcome)).toEqual(["limit_reached"]);
  });

  it("turns a thrown error into an internal error without leaking it", async () => {
    const d = await deps();
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = defineTool({ ...lookup, name: "boom", run: async () => { throw new Error("secret detail"); } });
    const result = await runTool(boom, { q: "x" }, d);
    expect(result.structuredContent).toMatchObject({ error: { code: "internal", retryable: true } });
    expect(JSON.stringify(result)).not.toContain("secret detail");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret detail");
    warn.mockRestore();
  });

  it("does not count self-counting tools as lookups", async () => {
    const d = await deps();
    await runTool(managerWrite, {}, d);
    expect(await d.db.select().from(schema.aiUsage)).toEqual([]);
  });
});
