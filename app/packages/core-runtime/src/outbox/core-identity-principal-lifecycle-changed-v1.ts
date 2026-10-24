import { Schema } from 'effect';

import { PrincipalIdSchema } from '../auth/external-identity-contracts.ts';

/** Wake-up only; consumers must reload current kind and status, never replay an event snapshot. */
export const OutboxPayloadSchema = Schema.Struct({
  data: Schema.Struct({ principalId: PrincipalIdSchema }),
});
export type OutboxPayload = typeof OutboxPayloadSchema.Type;

export const outboxTopic = 'core.identity.principal-lifecycle-changed.v1' as const;
export const outboxProducerModuleKey = 'core.identity' as const;
