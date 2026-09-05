// expect-count: 4
// A5 evasion: the raw driver failure reaches `detail` without ever naming `.message`.
// Each object is problem-shaped through `title` + `type`, so only `rawDriverMessage` can fire here.
declare const error: unknown;
declare const cause: unknown;
declare const dbError: unknown;

export const fromTemplate = {
  detail: `Contacts read failed: ${error}`,
  title: 'Contacts unavailable',
  type: 'https://ontos.dev/problems/contacts-unavailable',
};

export const fromConcatenation = {
  detail: 'Contacts read failed: ' + dbError,
  title: 'Contacts unavailable',
  type: 'https://ontos.dev/problems/contacts-unavailable',
};

export const fromReason = {
  reason: `${cause}`,
  title: 'Contacts unavailable',
  type: 'https://ontos.dev/problems/contacts-unavailable',
};

export const fromValue = {
  detail: error,
  title: 'Contacts unavailable',
  type: 'https://ontos.dev/problems/contacts-unavailable',
};
