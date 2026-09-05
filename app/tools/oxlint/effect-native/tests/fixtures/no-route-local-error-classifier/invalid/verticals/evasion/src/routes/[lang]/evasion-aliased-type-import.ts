// expect-count: 1
// The erased-union projection type is imported under a local alias, so matching on the bare
// identifier `ErrorClassificationInput` no longer sees it.
import type { ErrorClassificationInput as ClassificationInput } from '../../error-classification.ts';

type ContactsOutcome = { readonly _tag: 'ContactsForbidden' | 'ContactsMissing' };

export const listState = (input: ClassificationInput<ContactsOutcome>) =>
  input._tag === 'ContactsForbidden' ? 'forbidden' : 'not_found';
