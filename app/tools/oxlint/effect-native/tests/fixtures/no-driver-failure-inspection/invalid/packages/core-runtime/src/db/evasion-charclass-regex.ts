// EVASION: the same six SQLSTATE classes written with a character class (`/^5[3578]/u`) or a
// single-alternative group (`/^(?:08)/u`) miss both SQLSTATE_REGEX_PATTERNS probes, which require
// `|`-alternation or an exact `^dd$`. Fix: add probes for `^\^\((?:\?:)?[0-9]{2}\)` and
// `^\^[0-9](?:\[[0-9-]+\]|[0-9])`.
export const retryable = (code: string): boolean => /^5[3578]/u.test(code) || /^(?:08)/u.test(code);
