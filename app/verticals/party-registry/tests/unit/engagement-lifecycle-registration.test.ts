import { assert, it } from 'effect-rstest';
import {
  OrganizationEngagementLifecyclePayloadSchema,
  OrganizationEngagementProfileSchema,
  PersonEngagementLifecyclePayloadSchema,
  PersonEngagementProfileSchema,
} from '../../shared/domain/engagement-profile.ts';
import { archiveOrganizationEngagementAction } from '../../src/actions/archive-organization-engagement.action.ts';
import { archivePersonEngagementAction } from '../../src/actions/archive-person-engagement.action.ts';
import { unarchiveOrganizationEngagementAction } from '../../src/actions/unarchive-organization-engagement.action.ts';
import { unarchivePersonEngagementAction } from '../../src/actions/unarchive-person-engagement.action.ts';

const cases = [
  [
    'archive-person',
    archivePersonEngagementAction,
    PersonEngagementLifecyclePayloadSchema,
    PersonEngagementProfileSchema,
  ],
  [
    'unarchive-person',
    unarchivePersonEngagementAction,
    PersonEngagementLifecyclePayloadSchema,
    PersonEngagementProfileSchema,
  ],
  [
    'archive-organization',
    archiveOrganizationEngagementAction,
    OrganizationEngagementLifecyclePayloadSchema,
    OrganizationEngagementProfileSchema,
  ],
  [
    'unarchive-organization',
    unarchiveOrganizationEngagementAction,
    OrganizationEngagementLifecyclePayloadSchema,
    OrganizationEngagementProfileSchema,
  ],
] as const;

for (const [slug, action, payloadSchema, resultSchema] of cases) {
  it(`${slug} engagement retains its governed registration and exact schemas`, () => {
    const { descriptor } = action;
    const key = `party.registry.${slug}-engagement`;
    assert.equal(descriptor.actionKey, key);
    assert.equal(descriptor.entrypoint.entrypointKey, key);
    assert.deepEqual(descriptor.accessEvidencePolicy, {
      captureMode: 'metadata_only',
      policyKey: `${key}.access.v1`,
    });
    assert.equal(descriptor.payloadSchema, payloadSchema);
    assert.equal(descriptor.resultSchema, resultSchema);
    assert.equal(descriptor.legalEntityScope, 'required');
    assert.equal(descriptor.idempotency, 'required');
    assert.equal(descriptor.resourcePermission?.kind, 'resource');
    assert.equal(descriptor.entrypoint.access, 'write');
    assert.deepEqual(descriptor.entrypoint.authorization, {
      kind: 'action_execution',
      provisioning: 'tenant_membership_default',
    });
  });
}
