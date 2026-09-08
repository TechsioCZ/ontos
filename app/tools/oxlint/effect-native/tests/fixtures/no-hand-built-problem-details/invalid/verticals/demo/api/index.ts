// expect-count: 4
import { Effect } from 'effect';

// The BFF re-declares the RFC 9457 payload that `shared/api.ts` already owns through
// `Schema.TaggedStruct(...).pipe(HttpApiSchema.status(...))`. Every literal below is a second authority.
const problem = {
  authentication: () => ({
    _tag: 'ContactsAuthenticationProblem',
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: 401,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  }),
  conflict: () => ({
    _tag: 'ContactsConflictProblem',
    code: 'contacts_conflict',
    detail: 'The Contacts operation conflicts with the current state.',
    status: 409,
    title: 'Contacts operation conflict',
    type: 'https://ontos.dev/problems/contacts-conflict',
  }),
  notFound: () => ({
    _tag: 'ContactsNotFoundProblem',
    detail: 'The requested Contacts record was not found.',
    status: 404,
    title: 'Contacts record not found',
    type: 'https://ontos.dev/problems/contacts-not-found',
  }),
  unavailable: () => ({
    _tag: 'ContactsUnavailableProblem',
    detail: 'The Contacts operation is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Contacts unavailable',
    type: 'https://ontos.dev/problems/contacts-unavailable',
  }),
};

export const handler = Effect.succeed(problem.unavailable());
