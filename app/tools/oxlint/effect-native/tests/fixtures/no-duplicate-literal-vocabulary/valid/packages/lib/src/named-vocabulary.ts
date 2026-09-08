// The target pattern: declare the vocabulary once, reference it everywhere.
import { Schema } from 'effect';

export const PrincipalStatus = Schema.Literals(['active', 'disabled', 'archived']);
export type PrincipalStatus = typeof PrincipalStatus.Type;

export const PrincipalRow = Schema.Struct({
  principalStatus: PrincipalStatus,
  previousStatus: PrincipalStatus,
});

export const PrincipalMutation = Schema.Struct({
  expectedStatus: PrincipalStatus,
  newStatus: PrincipalStatus,
  observed: Schema.Array(PrincipalStatus),
});
