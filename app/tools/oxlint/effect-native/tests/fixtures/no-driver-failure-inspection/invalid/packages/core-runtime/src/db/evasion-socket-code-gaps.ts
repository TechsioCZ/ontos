// EVASION: `packages/core-runtime/src/actions/runtime.ts` already lists ECONNABORTED / EHOSTDOWN /
// ENETDOWN / ENETRESET / ENETUNREACH beside the seven default `networkCodes`; a new module that
// uses only those escapes completely. Fix: extend the default list to the codes already in-repo.
const RETRYABLE_SOCKET = new Set(['ECONNABORTED', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'ENETRESET']);
export const retryable = (code: string): boolean => RETRYABLE_SOCKET.has(code);
