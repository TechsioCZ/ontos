// expect-count: 2
// The file already owns the member list as a shared `const` array; both inline copies drift from it.
import { Schema } from 'effect';

const PRINCIPAL_STATUSES = ['active', 'disabled', 'revoked'] as const;

export const PrincipalStatus = Schema.Literals(PRINCIPAL_STATUSES);

export const CreatePrincipalPayload = Schema.Struct({
  status: Schema.Literals(['active', 'disabled', 'revoked']),
});

export const PrincipalRow = Schema.Struct({
  status: Schema.Literals(['revoked', 'active', 'disabled']),
});
