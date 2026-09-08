import type { OperationAuthenticationRequired } from './operation-authentication-required.ts';
import type { OperationContextDenied } from './operation-context-denied.ts';
import type { OperationContextInvalid } from './operation-context-invalid.ts';
import type { OperationContextUnavailable } from './operation-context-unavailable.ts';

export { OperationAuthenticationRequired } from './operation-authentication-required.ts';
export { OperationContextDenied } from './operation-context-denied.ts';
export { OperationContextInvalid } from './operation-context-invalid.ts';
export { OperationContextUnavailable } from './operation-context-unavailable.ts';

export type OperationContextError =
  | OperationAuthenticationRequired
  | OperationContextDenied
  | OperationContextInvalid
  | OperationContextUnavailable;
