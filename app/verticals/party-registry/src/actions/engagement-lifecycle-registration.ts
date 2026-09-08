import {
  defineActionResourcePermission,
  defineTenantModuleEntrypoint,
} from '@app/core-runtime';

import type {
  OrganizationEngagementLifecyclePayload,
  PersonEngagementLifecyclePayload,
} from '../../shared/domain/engagement-profile.ts';
import { EngagementLifecycleErrorSchema } from './engagement-lifecycle-handler.ts';

type EngagementLifecyclePayload =
  | OrganizationEngagementLifecyclePayload
  | PersonEngagementLifecyclePayload;
type EngagementLifecycleActionKey =
  `party.registry.${'archive' | 'unarchive'}-${'person' | 'organization'}-engagement`;

/** The shared governed-write contract; schemas and transaction services stay owner-specific. */
export const engagementLifecycleRegistration = <
  Payload extends EngagementLifecyclePayload,
>(
  actionKey: EngagementLifecycleActionKey
) =>
  ({
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: `${actionKey}.access.v1`,
    },
    actionKey,
    auditProfile: 'standard',
    domainErrorSchema: EngagementLifecycleErrorSchema,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
      entrypointKey: actionKey,
      moduleKey: 'party.registry',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleKey: 'party.registry',
    policies: [],
    resourcePermission: defineActionResourcePermission<Payload>((payload) => ({
      permission: 'write',
      resource: {
        moduleId: payload.profileRef.moduleId,
        resourceId: payload.profileRef.resourceId,
        resourceType: payload.profileRef.resourceType,
      },
    })),
    schemaVersion: '1',
  }) as const;
