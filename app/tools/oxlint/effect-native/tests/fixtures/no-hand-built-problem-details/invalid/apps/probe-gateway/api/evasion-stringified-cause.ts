// expect-count: 3
// A5 evasion: the PostgreSQL cause chain is stringified straight into the public payload.
declare const error: { readonly cause: unknown };
declare const dbError: unknown;

export const fromCauseChain = {
  detail: String(error.cause),
  title: 'Contacts unavailable',
  type: 'https://ontos.dev/problems/contacts-unavailable',
};

export const fromJson = {
  detail: JSON.stringify(dbError),
  title: 'Contacts unavailable',
  type: 'https://ontos.dev/problems/contacts-unavailable',
};

export const fromCauseTemplate = {
  detail: `Query failed: ${error.cause}`,
  title: 'Contacts unavailable',
  type: 'https://ontos.dev/problems/contacts-unavailable',
};
