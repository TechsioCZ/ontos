import { Schema } from 'effect';

export class SymmyJobLifecycleStoreError extends Schema.TaggedError<SymmyJobLifecycleStoreError>()(
  'SymmyJobLifecycleStoreError',
  { code: Schema.Literal('lifecycle_store_unavailable') },
) {}
