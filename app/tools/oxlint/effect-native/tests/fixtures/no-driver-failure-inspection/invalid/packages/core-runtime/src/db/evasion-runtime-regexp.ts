// EVASION: the SQLSTATE class regex written as a string for `new RegExp` is a plain string Literal,
// so the SQLSTATE_REGEX_PATTERNS probes (axis 5) never see it. Fix: run those probes against string
// literals too (at minimum the arguments of `new RegExp` / `RegExp(...)`).
const RETRYABLE_CLASS = new RegExp('^(?:08|40|53|55|57|58)', 'u');
export const retryable = (code: string): boolean => RETRYABLE_CLASS.test(code);
