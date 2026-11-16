import { randomUUID } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChangeCustomerProfileIcoPayloadSchema } from '../../shared/domain/customer-profile-ico.ts';
import {
  classifyCustomerProfileIcoMigration,
  CustomerProfileIcoMigrationPlanSchema,
} from '../../shared/domain/customer-profile-ico-migration.ts';
import type {
  CustomerProfileIcoMigrationPlan,
  CustomerProfileIcoMigrationTargetSchema,
} from '../../shared/domain/customer-profile-ico-migration.ts';

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const partyId = randomUUID();
const sourceContext = {
  issuer: 'internal-ebs',
  namespace: 'customer-profile-ico',
  occurrenceId: 'assertion-1',
  recordId: 'customer-1',
  recordType: 'profile',
  routeRef: 'internal-ico',
};
const profileRef = {
  kind: 'RETAIL' as const,
  moduleId: 'commerce.customer-context' as const,
  resourceId: randomUUID(),
  resourceType: 'commerce.customer-context.retail-customer-profile' as const,
  tenantId,
};
const authorizationSubject = {
  kind: 'RETAIL' as const,
  partyRef: {
    moduleId: 'party.registry' as const,
    resourceId: partyId,
    resourceType: 'party.registry.party' as const,
    tenantId,
  },
  sellingLegalEntityRef: {
    moduleId: 'core.identity' as const,
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity' as const,
    tenantId,
  },
};
const input = {
  asOf: '2026-11-07T00:00:00.000Z',
  planId: 'internal-migration-1',
  reason: 'Migrate approved internal fixture assertions',
  sourceContext,
};
const legacy = {
  assertionRef: {
    moduleId: 'party.registry' as const,
    resourceId: randomUUID(),
    resourceType: 'party.registry.party-official-identifier' as const,
    tenantId,
  },
  isCurrent: true,
  normalizedValue: '00000019',
  originalInput: { kind: 'UNKNOWN' as const },
  partyRef: authorizationSubject.partyRef,
  provenance: {
    acceptedByActionInvocationId: randomUUID(),
    acceptedByPrincipalId: randomUUID(),
    method: 'ACTOR_DECLARATION',
    policyVersion: '1',
    retractsAssertionId: null,
    source: 'original-fixture',
    supersedesAssertionId: null,
  },
  recordedAt: '2026-01-01T00:00:00.000Z',
  revision: 'a'.repeat(64),
  state: 'ACTIVE' as const,
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: null,
};
const target = { legalEntityId, lifecycle: 'ACTIVE' as const, profileRef, revision: 1, subjectResourceId: partyId };

it.effect('preserves exact original input and uses the published Czech syntax/checksum authority', () =>
  Effect.gen(function* icoInput() {
    const payload = {
      authorizationSubject,
      effectId: 'ico-1',
      effectiveAt: input.asOf,
      expectedRevision: 0,
      identifier: { identifierType: 'ICO', value: '19' },
      operation: 'SET',
      originalInput: ' 19 ',
      profileRef,
      provenance: {
        assertionId: 'source-1',
        countryCode: 'CZ',
        evidenceRef: 'evidence-1',
        source: 'fixture',
        sourceContext,
        sourceRevision: '1',
      },
      reason: 'Declare supplied Czech registration number',
    };
    const decoded = yield* Schema.decodeUnknownEffect(ChangeCustomerProfileIcoPayloadSchema)(payload);
    expect(decoded).toMatchObject({ identifier: { value: '19' }, originalInput: ' 19 ' });
    expect(
      Schema.is(ChangeCustomerProfileIcoPayloadSchema)({
        ...payload,
        identifier: { identifierType: 'ICO', value: '18' },
        originalInput: '18',
      }),
    ).toBe(false);
    expect(
      Schema.is(ChangeCustomerProfileIcoPayloadSchema)({
        ...payload,
        provenance: { ...payload.provenance, countryCode: 'SK' },
      }),
    ).toBe(false);
    expect(Schema.is(ChangeCustomerProfileIcoPayloadSchema)({ ...payload, identifier: null })).toBe(false);
  }),
);

it.effect('classifies complete zero, one, many, historical and conflicting legacy records without fanout', () =>
  Effect.gen(function* icoClassification() {
    const classify = (
      targets: readonly (typeof CustomerProfileIcoMigrationTargetSchema.Type)[],
      assertions = [legacy],
    ) =>
      classifyCustomerProfileIcoMigration(
        input,
        { assertions, snapshotVersion: 'b'.repeat(64), tenantId },
        targets,
        'target-1',
        { legalEntityId, observedAt: input.asOf },
      );
    expect(classify([{ ...target, legalEntityId: randomUUID() }]).records[0]?.classification).toBe(
      'TARGET_SCOPE_UNAUTHORIZED',
    );
    const earlierPlan = classifyCustomerProfileIcoMigration(
      { ...input, asOf: '2025-01-01T00:00:00.000Z' },
      { assertions: [legacy], snapshotVersion: 'b'.repeat(64), tenantId },
      [target],
      'target-1',
      { legalEntityId, observedAt: input.asOf },
    );
    expect(earlierPlan.records[0]?.classification).toBe('CURRENT_OUTSIDE_PLAN_TIME');
    expect(classify([]).records[0]?.classification).toBe('NO_TARGET');
    expect(classify([{ ...target, reconciliationRequired: true }]).records[0]?.classification).toBe(
      'TARGET_INELIGIBLE',
    );
    const one = classify([target]);
    expect(one.records[0]?.classification).toBe('MATCHED');
    const safeOrganization = classifyCustomerProfileIcoMigration(
      input,
      {
        assertions: [{ ...legacy, provenance: { ownerReceiptRef: legacy.assertionRef } }],
        snapshotVersion: 'b'.repeat(64),
        tenantId,
      },
      [target],
      'target-1',
      { legalEntityId, observedAt: input.asOf },
    );
    expect(safeOrganization.records[0]?.classification).toBe('MATCHED');
    expect(safeOrganization.records[0]?.legacy.provenance).toEqual({ ownerReceiptRef: legacy.assertionRef });

    expect(one.records[0]?.legacy.originalInput).toEqual({ kind: 'UNKNOWN' });
    expect(
      classify([
        target,
        { ...target, legalEntityId: randomUUID(), profileRef: { ...profileRef, resourceId: randomUUID() } },
      ]).records[0]?.classification,
    ).toBe('MULTIPLE_TARGETS');
    expect(
      classify(
        [target],
        [
          legacy,
          {
            ...legacy,
            assertionRef: { ...legacy.assertionRef, resourceId: randomUUID() },
            normalizedValue: '27074358',
          },
        ],
      ).records.map((row) => row.classification),
    ).toEqual(['CONFLICTING_LEGACY_VALUES', 'CONFLICTING_LEGACY_VALUES']);
    const ended = { ...legacy, isCurrent: false, state: 'ENDED' as const, validTo: input.asOf };
    const historical = classifyCustomerProfileIcoMigration(
      input,
      { assertions: [ended], snapshotVersion: 'b'.repeat(64), tenantId },
      [target],
      'target-1',
      { legalEntityId, observedAt: input.asOf },
    );
    expect(historical.records[0]?.classification).toBe('HISTORICAL_ONLY');
    const decoded: CustomerProfileIcoMigrationPlan = yield* Schema.decodeUnknownEffect(
      CustomerProfileIcoMigrationPlanSchema,
    )(one);
    expect(decoded.records[0]?.targets).toHaveLength(1);
  }),
);
