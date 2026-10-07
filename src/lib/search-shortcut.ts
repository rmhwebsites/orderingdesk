// Which searches go to the AI model (design section 3): an order or request
// number, or one or two words, run as keyword search with no model call.
// Shared by the desk (it asks only when this says so) and the AI route (it
// checks again). Relative imports only.

export const AI_QUERY_MAX = 200;

const ORDER_NUMBER = /^#?\s*d?\s*\d+$/i;

export function shouldAskAi(query: string): boolean {
  const text = query.trim();
  if (text.length === 0 || ORDER_NUMBER.test(text)) {
    return false;
  }
  return text.split(/\s+/).length > 2;
}
