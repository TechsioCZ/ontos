// expect-count: 1
// Mirrors packages/core-runtime/src/auth/principal-administration-reads.ts: the binding-status
// vocabulary is written out twice with no name to reference.
import { Schema } from 'effect';

const bindingMetadata = Schema.Struct({
  status: Schema.Literals(['active', 'disabled', 'revoked']),
});

const ManagedItem = Schema.Struct({
  bindingStatus: Schema.NullOr(Schema.Literals(['active', 'disabled', 'revoked'])),
  kind: Schema.Literals(['service', 'integration']),
  principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
});

export const ManagedResult = Schema.Struct({
  items: Schema.Array(ManagedItem),
  metadata: bindingMetadata,
});
