/**
 * The shared frontend failure vocabulary: exactly what the audit's A9 target asks for. It lives
 * outside `routeGlobs`, so classifiers here are the fix, not the anti-pattern.
 */
import { Match } from 'effect';
import type { ErrorClassificationInput } from '../error-classification.ts';

export type ContactsFailure =
  | { readonly _tag: 'ContactsForbiddenProblem' }
  | { readonly _tag: 'ContactsNotFoundProblem' };

export const toFrontendFailure = Match.typeTags<ContactsFailure>()({
  ContactsForbiddenProblem: () => 'forbidden' as const,
  ContactsNotFoundProblem: () => 'not_found' as const,
});

export const classifyContactsFailure = (error: ErrorClassificationInput<ContactsFailure>) =>
  error._tag === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found';
