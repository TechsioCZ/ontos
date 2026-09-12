import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { CustomerGroupHistoryRequestSchema } from '../../shared/apis/customer-group-history.ts';
import { CustomerGroupMembersRequestSchema } from '../../shared/apis/customer-group-members.ts';
import { EffectiveCustomerGroupMembershipsRequestSchema } from '../../shared/apis/effective-customer-group-memberships.ts';
import { CustomerGroupActionAuditEvidenceSchema } from '../../shared/domain/group-contract.ts';
import {
  AssignCustomerGroupPayloadSchema,
  assignCustomerGroupAction,
} from '../../src/actions/assign-customer-group.action.ts';
import { archiveCustomerGroupAction } from '../../src/actions/archive-customer-group.action.ts';
import {
  CreateCustomerGroupPayloadSchema,
  createCustomerGroupAction,
} from '../../src/actions/create-customer-group.action.ts';
import { reactivateCustomerGroupAction } from '../../src/actions/reactivate-customer-group.action.ts';
import { removeCustomerGroupAction } from '../../src/actions/remove-customer-group.action.ts';
import {
  UpdateCustomerGroupPayloadSchema,
  updateCustomerGroupAction,
} from '../../src/actions/update-customer-group.action.ts';
import { customerGroupDetailRead } from '../../src/api/customer-group-detail.read.ts';
import { customerGroupHistoryRead } from '../../src/api/customer-group-history.read.ts';
import { customerGroupMembersRead } from '../../src/api/customer-group-members.read.ts';
import { effectiveCustomerGroupMembershipsRead } from '../../src/api/effective-customer-group-memberships.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const groupRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
} as const;
const retailProfile = {
  profileKind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '30000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
} as const;

describe('Commerce Customer Group contracts', () => {
  it('registers every explicit mutation as required-idempotency, Legal-Entity-scoped Action', () => {
    const actions = [
      createCustomerGroupAction,
      updateCustomerGroupAction,
      archiveCustomerGroupAction,
      reactivateCustomerGroupAction,
      assignCustomerGroupAction,
      removeCustomerGroupAction,
    ];
    expect(actions).toHaveLength(6);
    for (const action of actions) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('required');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
  });

  it('rejects an empty or reversed membership period at the public boundary', () => {
    const decode = Schema.decodeUnknownSync(AssignCustomerGroupPayloadSchema);
    const valid = decode({
      effectiveFrom: '2026-09-09T10:00:00.000Z',
      effectiveTo: '2026-09-09T10:00:00.001Z',
      groupRef,
      profile: retailProfile,
      reason: 'Contract test',
    });
    expect(valid.effectiveTo).toBe('2026-09-09T10:00:00.001Z');
    expect(() =>
      decode({
        ...valid,
        effectiveTo: valid.effectiveFrom,
      }),
    ).toThrow();
  });

  it('declares exact Resource authorization for assignment and lifecycle changes', () => {
    expect(assignCustomerGroupAction.descriptor.resourcePermission?.kind).toBe('resource');
    expect(archiveCustomerGroupAction.descriptor.resourcePermission?.kind).toBe('resource');
  });

  it('derives update classification instead of accepting caller semantic labels', () => {
    const decoded = Schema.decodeUnknownSync(UpdateCustomerGroupPayloadSchema)({
      changeKind: 'TYPO_CORRECTION',
      description: 'Presentation-only staff description',
      expectedRevision: 1,
      groupRef,
      membershipCriteria: 'Stable membership criteria',
      membershipReassessmentRequired: false,
      name: 'Stable group',
      purpose: 'Stable business purpose',
      reason: 'Correct presentation',
    });
    expect('changeKind' in decoded).toBe(false);
    expect('membershipReassessmentRequired' in decoded).toBe(false);
  });

  it('keeps audit evidence bounded even when valid definitions use their maximum length', () => {
    const maximumDefinitionText = 'x'.repeat(4000);
    expect(
      Schema.is(CreateCustomerGroupPayloadSchema)({
        businessCode: 'MAXIMUM_DEFINITION',
        description: maximumDefinitionText,
        initialState: 'ACTIVE',
        meaningKey: 'maximum.definition',
        membershipCriteria: maximumDefinitionText,
        name: 'Maximum definition',
        purpose: maximumDefinitionText,
        reason: 'Exercise bounded audit evidence',
      }),
    ).toBe(true);
    const evidence = Schema.decodeUnknownSync(CustomerGroupActionAuditEvidenceSchema)({
      afterDefinitionRevision: 2,
      beforeDefinitionRevision: 1,
      changed: true,
      definitionChangeKind: 'DESCRIPTION_CLARIFICATION',
      effectiveAt: '2026-09-09T10:00:00.000Z',
      groupRef,
      operation: 'UPDATE',
      reason: 'Bounded revision evidence',
      revision: 2,
    });
    expect(JSON.stringify(evidence).length).toBeLessThan(4096);
    expect('afterDefinition' in evidence).toBe(false);
    expect('beforeDefinition' in evidence).toBe(false);
  });

  it('uses governed resource reads and a distinct historical-read entrypoint', () => {
    expect(customerGroupDetailRead.descriptor.permissionTarget).toBe('resource');
    expect(customerGroupMembersRead.descriptor.accessKind).toBe('list');
    expect(customerGroupHistoryRead.descriptor.entrypoint.access).toBe('historical_read');
    expect(customerGroupHistoryRead.descriptor.entrypoint.authorization).toEqual({
      kind: 'context_permission',
      permission: 'customer.group.history.read',
    });
    expect(effectiveCustomerGroupMembershipsRead.descriptor.permissionTarget).toBe('resource');

    expect(customerGroupDetailRead.descriptor.accessKind).toBe('detail');
    expect(customerGroupMembersRead.descriptor.permissionTarget).toBe('resource');
  });

  it('accepts caller-selected time only through the authorized history contract', () => {
    const callerTime = '2026-09-01T10:00:00.000Z';
    const currentMembers = Schema.decodeUnknownSync(CustomerGroupMembersRequestSchema)({
      effectiveAt: callerTime,
      groupRef,
    });
    const currentProfileGroups = Schema.decodeUnknownSync(EffectiveCustomerGroupMembershipsRequestSchema)({
      asOf: callerTime,
      profile: retailProfile,
    });
    const historical = Schema.decodeUnknownSync(CustomerGroupHistoryRequestSchema)({
      asOf: callerTime,
      groupRef,
    });
    expect('effectiveAt' in currentMembers).toBe(false);
    expect(currentProfileGroups.asOf).toBe(callerTime);
    expect(historical.asOf).toBe(callerTime);
    expect(effectiveCustomerGroupMembershipsRead.descriptor.entrypoint.authorization).toEqual({
      kind: 'context_permission',
      permission: 'customer.group.history.read',
    });
    expect(customerGroupHistoryRead.descriptor.policies).toEqual([]);
    expect(effectiveCustomerGroupMembershipsRead.descriptor.policies).toEqual([]);
  });

  it('does not invent a retention cutoff for authorized effective-set queries', () => {
    const historical = Schema.decodeUnknownSync(EffectiveCustomerGroupMembershipsRequestSchema)({
      asOf: '1900-01-01T00:00:00.000Z',
      profile: retailProfile,
    });
    const scheduledFuture = Schema.decodeUnknownSync(EffectiveCustomerGroupMembershipsRequestSchema)({
      asOf: '2200-01-01T00:00:00.000Z',
      profile: retailProfile,
    });

    expect(historical.asOf).toBe('1900-01-01T00:00:00.000Z');
    expect(scheduledFuture.asOf).toBe('2200-01-01T00:00:00.000Z');
  });
});
