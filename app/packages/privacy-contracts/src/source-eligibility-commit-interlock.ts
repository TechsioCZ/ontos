import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

/** Synchronization only: no owner data or decision. The governed Privacy read must run after this lock. */
export const holdSourceEligibilityStable = defineScopedRoutine({
  name: 'hold_source_eligibility_stable',
  ownerModuleKey: 'privacy.core',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ held: Schema.Boolean }),
  routineKey: 'privacy.core.hold-source-eligibility-stable',
  schema: 'privacy',
});
