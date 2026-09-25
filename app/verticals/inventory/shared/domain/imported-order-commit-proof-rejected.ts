import { Schema } from 'effect';

export class ImportedOrderCommitProofRejected extends Schema.TaggedError<ImportedOrderCommitProofRejected>()(
  'ImportedOrderCommitProofRejected',
  {
    code: Schema.Literal('imported_order_commit_proof_rejected'),
    reason: Schema.Literals(['ORDER_NOT_PROVEN_COMMITTED', 'SOURCE_LINEAGE_INVALID']),
  },
) {}
