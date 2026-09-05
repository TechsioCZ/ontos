// Narrowing the accepted set for one endpoint is domain modelling, not duplication
// (`reportSubsets` is off by default).
import { Schema } from 'effect';

export const BindingStatus = Schema.Literals(['active', 'disabled', 'revoked']);

export const SetBindingStatusPayload = Schema.Struct({
  expectedStatus: BindingStatus,
  newStatus: Schema.Literals(['active', 'disabled']),
});

export const ArchivePayload = Schema.Struct({
  newStatus: Schema.Literals(['disabled', 'revoked']),
});
