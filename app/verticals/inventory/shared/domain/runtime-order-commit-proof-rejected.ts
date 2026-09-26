import { Schema } from 'effect';

export class RuntimeOrderCommitProofRejected extends Schema.TaggedError<RuntimeOrderCommitProofRejected>()(
  'RuntimeOrderCommitProofRejected',
  {
    code: Schema.Literal('runtime_order_commit_proof_rejected'),
    reason: Schema.Literal('ORDER_NOT_PROVEN_COMMITTED'),
  },
) {}
