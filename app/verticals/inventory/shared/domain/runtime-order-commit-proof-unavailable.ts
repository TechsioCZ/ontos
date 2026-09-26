import { Schema } from 'effect';

export class RuntimeOrderCommitProofUnavailable extends Schema.TaggedError<RuntimeOrderCommitProofUnavailable>()(
  'RuntimeOrderCommitProofUnavailable',
  {
    code: Schema.Literal('runtime_order_commit_proof_unavailable'),
    reason: Schema.String,
  },
) {}
