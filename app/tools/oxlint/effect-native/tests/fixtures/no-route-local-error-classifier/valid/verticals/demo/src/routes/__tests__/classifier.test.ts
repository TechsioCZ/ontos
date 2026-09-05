// Tests exercising the closed vocabulary are healthy and out of scope.
import { classifyContactsFailure } from '../../errors/frontend-failure.ts';

export const classifyForTest = (error: { readonly _tag: string }) =>
  error._tag === 'ContactsForbiddenProblem' ? 'forbidden' : 'not_found';

export const cases = [classifyContactsFailure, classifyForTest];
