// The AI search filter (design section 3). Task 15 completes this module.
export type SearchVocabulary = {
  statuses: { key: string; label: string }[];
  locations: { id: string; name: string }[];
  items: string[];
};

export function aiFilterSchema(_vocab: SearchVocabulary): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: [], properties: {} };
}

export function aiSystemPrompt(_vocab: SearchVocabulary, today: string): string {
  return `Today is ${today} in the workspace's time zone.`;
}
