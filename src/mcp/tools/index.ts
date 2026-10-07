// Every MCP tool, in the order tools/list shows them (Wave 2 plan, Decision
// 16): 8 reads for staff and up, find_products for managers, and 7 prepare
// and confirm pairs.
import { getMyAccess } from "./access";
import { confirmCancel, confirmEditRequest, prepareCancel, prepareEditRequest } from "./cancel-edit";
import type { ToolDef } from "./define";
import { findPeople, getLocation, getPerson, listLocations } from "./lookup";
import { getOrder, listStatuses, searchOrders } from "./orders";
import { confirmPlaceRequest, findProducts, preparePlaceRequest } from "./place-request";
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
  findProducts,
  prepareStatusChange,
  confirmStatusChange,
  prepareAddNote,
  confirmAddNote,
  prepareApprove,
  confirmApprove,
  prepareReject,
  confirmReject,
  prepareCancel,
  confirmCancel,
  prepareEditRequest,
  confirmEditRequest,
  preparePlaceRequest,
  confirmPlaceRequest,
];
