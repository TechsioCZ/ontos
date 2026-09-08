// expect-count: 4
import { Match } from 'effect';
import * as Errors from '../../../error-classification.ts';

type DetailError = { readonly _tag: 'ContactsNotFoundProblem' | 'ContactsInternalProblem' };

// Axis 2 via a qualified type name.
export const detailErrorState = (error: Errors.ErrorClassificationInput<DetailError>) =>
  error._tag === 'ContactsNotFoundProblem' ? 'not_found' : 'unexpected';

// Axis 2 nested inside a union / array / generic annotation.
export function firstFailureState(
  failures: ReadonlyArray<Errors.ErrorClassificationInput<DetailError> | undefined>,
) {
  return failures.length;
}

// Axis 3: destructured `_tag` parameter, no error-ish parameter name at all.
export const badgeFor = ({ _tag }: DetailError) =>
  Match.value(_tag).pipe(Match.orElse(() => 'unknown'));

// Axis 3: optional-chained, computed `_tag` read on an error-shaped annotation.
export const toastFor = (cause: DetailError | undefined) =>
  cause?.['_tag'] === 'ContactsInternalProblem' ? 'retry' : 'dismiss';
