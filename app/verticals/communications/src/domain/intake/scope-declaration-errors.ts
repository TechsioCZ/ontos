import { Data } from 'effect';

/** No producer declared the exact Privacy scope of this message; Privacy is never asked about a guess. */
export class ProcessingScopeUndeclared extends Data.TaggedError('ProcessingScopeUndeclared')<{
  readonly reason: 'NO_DECLARATION' | 'DECLARATION_UNAVAILABLE';
}> {}
