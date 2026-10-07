import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import * as z from "zod";
import * as schema from "@/db/schema";
import { runTool, toolsFor } from "./registry";
import { ALL_TOOLS } from "./tools";
import { CONFIRM_DESTRUCTIVE, READ, defineTool, fail, ok, type ToolDeps } from "./tools/define";
import { MANAGER, NOW, WS, principalFor, setupMcp, testEnv } from "./test-helpers";

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

  // A failed count (D1 dropped the connection or timed out) must not escape
  // the wrapper: the MCP SDK would send the error's message, which for a
  // Drizzle query names the SQL and its ids, to the chat app as raw text.
  it("turns a failed lookup count into the same internal error, and audits it", async () => {
    const d = await deps();
    await d.db.run(sql`drop table ai_usage`);
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let ran = false;
    const counted = defineTool({ ...lookup, name: "counted", run: async () => { ran = true; return ok({}); } });
    const result = await runTool(counted, { q: "x" }, d);
    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "internal", message: "Ordering Desk hit an error. Check the card in Ordering Desk before trying again.", retryable: true },
    });
    for (const leak of ["ai_usage", "no such table", "insert", WS, MANAGER]) {
      expect(JSON.stringify(result), leak).not.toContain(leak);
    }
    // The log line carries ids, the tool and the error's name only.
    for (const leak of ["ai_usage", "no such table", "insert"]) {
      expect(JSON.stringify(warn.mock.calls), leak).not.toContain(leak);
    }
    expect((await d.db.select().from(schema.auditLog)).map((row) => [row.tool, row.outcome])).toEqual([["counted", "internal"]]);
    warn.mockRestore();
  });

  it("does not count self-counting tools as lookups", async () => {
    const d = await deps();
    await runTool(managerWrite, {}, d);
    expect(await d.db.select().from(schema.aiUsage)).toEqual([]);
  });
});

describe("the tool catalog", () => {
  it("lists every tool once, with the annotations and roles the plan fixes", () => {
    const names = ALL_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(23);
    for (const tool of ALL_TOOLS) {
      const prepareOrRead = !tool.name.startsWith("confirm_");
      expect(tool.annotations.readOnlyHint, tool.name).toBe(prepareOrRead);
      expect(tool.annotations.openWorldHint, tool.name).toBe(false);
      expect(tool.counts, tool.name).toBe(prepareOrRead ? "read" : "self");
      expect(tool.needsWrite, tool.name).toBe(tool.name.startsWith("prepare_") || tool.name.startsWith("confirm_") || tool.name === "find_products");
    }
    const destructive = ALL_TOOLS.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name).sort();
    expect(destructive).toEqual(["confirm_approve", "confirm_cancel", "confirm_edit_request", "confirm_reject", "confirm_status_change"]);
    expect(toolsFor(principalFor("staff"), ALL_TOOLS).map((tool) => tool.name)).toEqual([
      "get_my_access",
      "search_orders",
      "get_order",
      "list_statuses",
      "find_people",
      "get_person",
      "list_locations",
      "get_location",
      "prepare_status_change",
      "confirm_status_change",
      "prepare_add_note",
      "confirm_add_note",
    ]);
    expect(toolsFor(principalFor("manager", { scopes: ["desk.read"] }), ALL_TOOLS)).toHaveLength(8);
  });
});
