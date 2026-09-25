import { Schema } from 'effect';

export class ImportedOrderCommitProofUnavailable extends Schema.TaggedError<ImportedOrderCommitProofUnavailable>()(
  'ImportedOrderCommitProofUnavailable',
  {
    code: Schema.Literal('imported_order_commit_proof_unavailable'),
    reason: Schema.String,
  },
) {}
