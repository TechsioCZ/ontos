import { Schema } from 'effect';

import {
  ActionInvocationIdSchema,
  AuthBindingIdSchema,
  AuthBindingStatusSchema,
  AuthenticationNamespaceIdSchema,
  BindingRevisionSchema,
  PrincipalIdSchema,
} from '../external-identity-contracts.ts';

const reason = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500));
const boundedReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Secret-safe evidence for the neutral Core identity lifecycle Actions. */
export const ExternalIdentityActionAuditEvidenceSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  bindingRevision: BindingRevisionSchema,
  newStatus: Schema.optionalKey(AuthBindingStatusSchema),
  operation: Schema.Literals(['reserve', 'activate', 'status']),
  previousStatus: Schema.optionalKey(AuthBindingStatusSchema),
  principalId: PrincipalIdSchema,
  reason: Schema.optionalKey(reason),
  reconciliationRef: Schema.optionalKey(boundedReference),
  transitionRef: Schema.optionalKey(ActionInvocationIdSchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
