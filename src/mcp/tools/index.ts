// Every MCP tool, in the order tools/list shows them. Later tasks append.
import { getMyAccess } from "./access";
import type { ToolDef } from "./define";
import { findPeople, getLocation, getPerson, listLocations } from "./lookup";
import { getOrder, listStatuses, searchOrders } from "./orders";
import { confirmApprove, confirmReject, prepareApprove, prepareReject } from "./review";
import { confirmAddNote, confirmStatusChange, prepareAddNote, prepareStatusChange } from "./status-note";

export const ALL_TOOLS: ToolDef[] = [
  getMyAccess,
  searchOrders,
  getOrder,
  listStatuses,
  findPeople,
  getPerson,
  listLocations,
  getLocation,
  prepareStatusChange,
  confirmStatusChange,
  prepareAddNote,
  confirmAddNote,
  prepareApprove,
  confirmApprove,
  prepareReject,
  confirmReject,
];
