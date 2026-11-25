import type { ProviderObservationInput } from '@app/communications-contracts/message-handoff';

import { deterministicUuid } from '../intake/identity.ts';

/**
 * A provider observation as step 22 hands it to Communications (#1402) is the PUBLISHED input contract of the handoff
 * (`@app/communications-contracts/message-handoff`): this owner keeps no second copy, so the adapter meets exactly one shape
 * and Communications stays the only interpreter into the business vocabulary.
 */
export {
  ObservationTenantIdSchema,
  ProviderObservationInputSchema,
} from '@app/communications-contracts/message-handoff';
export type { ProviderObservationInput } from '@app/communications-contracts/message-handoff';

/**
 * The one row an observation identity can ever be: a repeated callback derives the same id. The evidence kind is part of the
 * identity, so one provider message id may carry an acceptance and, later, a bounce as two observations.
 */
export const observationIdOf = (input: ProviderObservationInput) =>
  deterministicUuid(
    'communications.provider-observation',
    [input.tenantId, input.attemptId, input.providerKey, input.observationKey, input.evidence.kind].join('|'),
  );
