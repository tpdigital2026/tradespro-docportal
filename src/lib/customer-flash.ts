/** Where the customer page goes after a save, and what it says. One place so the action and the page agree. */
export type SavedKind = 'updated' | 'created';

export function customerSavedUrl(id: string, kind: SavedKind): string {
  return `/customers/${id}?saved=${kind}`;
}

/** The query value back to a kind. The old "1" counts as updated. Anything else shows nothing. */
export function savedKindFrom(value: string | string[] | undefined): SavedKind | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === 'created') return 'created';
  if (v === 'updated' || v === '1') return 'updated';
  return null;
}

export const SAVED_TEXT: Record<SavedKind, string> = {
  updated: 'Saved. Their details are up to date.',
  created: 'Saved. This customer has been added.',
};
