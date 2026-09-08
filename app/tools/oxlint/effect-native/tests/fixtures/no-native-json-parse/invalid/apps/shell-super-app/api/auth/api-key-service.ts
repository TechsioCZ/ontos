// expect-count: 3
declare const row: { readonly metadata: string | null };

// C1: API-key metadata round-trips through hand JSON.
export const metadata = row.metadata === null ? {} : JSON.parse(row.metadata);

// The same defect reached through a container global.
export const impersonation = globalThis.JSON.parse(String(row.metadata));

// Destructured capability: reported once at the binding.
const { parse } = JSON;
export const scopes = parse("[]");
