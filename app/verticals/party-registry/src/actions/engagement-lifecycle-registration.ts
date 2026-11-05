import { defineTenantModuleEntrypoint } from '@app/core-runtime';

import type {
  OrganizationEngagementLifecyclePayload,
  PersonEngagementLifecyclePayload,
} from '../../shared/domain/engagement-profile.ts';
import { EngagementLifecycleErrorSchema } from './engagement-lifecycle-handler.ts';

type EngagementLifecyclePayload = OrganizationEngagementLifecyclePayload | PersonEngagementLifecyclePayload;
type EngagementLifecycleActionKey = `party.registry.${'archive' | 'unarchive'}-${'person' | 'organization'}-engagement`;

/** The shared governed-write contract; schemas and transaction services stay owner-specific. */
export const engagementLifecycleRegistration = <Payload extends EngagementLifecyclePayload>(
  actionKey: EngagementLifecycleActionKey,
) =>
  ({
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: `${actionKey}.access.v1`,
    },
    // The profile is the record this capability governs (O9, O27).
    accessTarget: (payload: Payload) => ({ moduleKey: 'party.registry', recordKey: payload.profileRef.resourceId }),
    actionKey,
    auditProfile: 'standard',
    domainErrorSchema: EngagementLifecycleErrorSchema,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: actionKey,
      moduleKey: 'party.registry',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleKey: 'party.registry',
    policies: [],
    schemaVersion: '1',
  }) as const;
