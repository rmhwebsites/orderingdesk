// Every MCP tool, in the order tools/list shows them. Later tasks append.
import { getMyAccess } from "./access";
import type { ToolDef } from "./define";
import { getOrder, listStatuses, searchOrders } from "./orders";

export const ALL_TOOLS: ToolDef[] = [getMyAccess, searchOrders, getOrder, listStatuses];
