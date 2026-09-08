import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CounterpartyReadRequestSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import {
  CounterpartyRoleHistoryRequestSchema,
  CounterpartyRoleHistoryResponseSchema,
} from '../../shared/apis/counterparty-role-history.ts';
import {
  CounterpartyAuditEvidenceSchema,
  CounterpartyIsoTimestampSchema,
  CounterpartyPartyProjectionSchema,
  CounterpartyRolePeriodSchema,
  LegalEntityRefSchema,
} from '../../shared/domain/counterparty-contract.ts';
import { OutboxPayloadSchema as CounterpartyCreatedOutboxPayloadSchema } from '../../shared/outbox/party-registry-counterparty-created-v1.ts';
import { OutboxPayloadSchema as CounterpartyRoleAddedOutboxPayloadSchema } from '../../shared/outbox/party-registry-counterparty-role-added-v1.ts';
import { OutboxPayloadSchema as CounterpartyRoleEndedOutboxPayloadSchema } from '../../shared/outbox/party-registry-counterparty-role-ended-v1.ts';
import {
  CounterpartyCreatePayloadSchema,
  CounterpartyCreateResultSchema,
  counterpartyCreateAction,
} from '../../src/actions/counterparty-create.action.ts';
import {
  CounterpartyRoleAddPayloadSchema,
  CounterpartyRoleAddResultSchema,
  counterpartyRoleAddAction,
} from '../../src/actions/counterparty-role-add.action.ts';
import {
  CounterpartyRoleEndPayloadSchema,
  CounterpartyRoleEndResultSchema,
  counterpartyRoleEndAction,
} from '../../src/actions/counterparty-role-end.action.ts';
import {
  counterpartyReadPermissionTarget,
  counterpartyReadRead,
} from '../../src/api/counterparty-read.read.ts';
import {
  counterpartyRoleHistoryPermissionTarget,
  counterpartyRoleHistoryRead,
} from '../../src/api/counterparty-role-history.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const counterpartyId = '40000000-0000-4000-8000-000000000001';
const rolePeriodId = '50000000-0000-4000-8000-000000000001';

const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const rolePeriodRef = {
  moduleId: 'party.registry',
  resourceId: rolePeriodId,
  resourceType: 'party.registry.counterparty-role-period',
  tenantId,
} as const;
const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const provenance = {
  evidenceReference: 'contract:2026-42',
  method: 'SIGNED_CONTRACT',
  reason: 'Signed commercial agreement establishes the context.',
  source: 'contracts.core',
} as const;

it('declares required Legal Entity scope and Counterparty resource authorization', () => {
  expect(
    [
      counterpartyCreateAction,
      counterpartyRoleAddAction,
      counterpartyRoleEndAction,
    ].map(({ descriptor }) => ({
      actionKey: descriptor.actionKey,
      idempotency: descriptor.idempotency,
      legalEntityPermission: descriptor.legalEntityPermission,
      legalEntityScope: descriptor.legalEntityScope,
      resourcePermission: descriptor.resourcePermission?.kind,
    }))
  ).toEqual([
    {
      actionKey: 'party.registry.counterparty-create',
      idempotency: 'required',
      legalEntityPermission: 'manage_counterparty',
      legalEntityScope: 'required',
      resourcePermission: undefined,
    },
    {
      actionKey: 'party.registry.counterparty-role-add',
      idempotency: 'required',
      legalEntityPermission: undefined,
      legalEntityScope: 'required',
      resourcePermission: 'resource',
    },
    {
      actionKey: 'party.registry.counterparty-role-end',
      idempotency: 'required',
      legalEntityPermission: undefined,
      legalEntityScope: 'required',
      resourcePermission: 'resource',
    },
  ]);
});

it.effect(
  'creates a durable Counterparty without inventing an implicit role',
  () =>
    Effect.gen(function* contractScenario2() {
      const payload = yield* Schema.decodeEffect(
        CounterpartyCreatePayloadSchema,
        {
          onExcessProperty: 'error',
        }
      )({ partyRef, provenance });
      expect(payload).toEqual({ partyRef, provenance });
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(CounterpartyCreatePayloadSchema, {
            onExcessProperty: 'error',
          })({
            partyRef,
            provenance,
            roleType: 'CUSTOMER',
          })
        )
      ).toBeDefined();
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(CounterpartyCreatePayloadSchema)({
            partyRef,
            provenance: {
              method: 'SIGNED_CONTRACT',
              reason: 'Evidence is mandatory.',
              source: 'test',
            },
          })
        )
      ).toBeDefined();
      expect(
        yield* Schema.decodeEffect(CounterpartyCreateResultSchema)({
          counterpartyRef,
          created: true,
          legalEntityRef,
          partyRef,
        })
      ).toEqual({ counterpartyRef, created: true, legalEntityRef, partyRef });
    })
);

it.effect('publishes only stable references and bounded lifecycle facts', () =>
  Effect.gen(function* contractScenario3() {
    expect(
      yield* Schema.decodeEffect(CounterpartyCreatedOutboxPayloadSchema, {
        onExcessProperty: 'error',
      })({ counterpartyRef, legalEntityRef, partyRef })
    ).toEqual({ counterpartyRef, legalEntityRef, partyRef });
    const added = {
      counterpartyRef,
      rolePeriodRef,
      roleType: 'SUPPLIER' as const,
      validFrom: '2026-09-03T10:00:00.000Z',
      validTo: null,
    };
    expect(
      yield* Schema.decodeEffect(CounterpartyRoleAddedOutboxPayloadSchema)(
        added
      )
    ).toEqual(added);
    expect(
      (yield* Schema.decodeEffect(CounterpartyRoleEndedOutboxPayloadSchema)({
        ...added,
        validTo: '2027-01-31T23:59:59.000Z',
      })).validTo
    ).toBe('2027-01-31T23:59:59.000Z');
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(CounterpartyCreatedOutboxPayloadSchema, {
          onExcessProperty: 'error',
        })({ counterpartyRef, displayName: 'ACME', legalEntityRef, partyRef })
      )
    ).toBeDefined();
  })
);

it.effect(
  'preserves Counterparty JSON round trips for timestamps, references, and absence',
  () =>
    Effect.gen(function* contractScenario4() {
      const timestamp = '2026-09-03T10:00:00.000Z';
      expect(
        yield* Schema.encodeEffect(CounterpartyIsoTimestampSchema)(
          yield* Schema.decodeEffect(CounterpartyIsoTimestampSchema)(timestamp)
        )
      ).toBe(timestamp);
      expect(
        yield* Schema.encodeEffect(LegalEntityRefSchema)(
          yield* Schema.decodeEffect(LegalEntityRefSchema)(legalEntityRef)
        )
      ).toEqual(legalEntityRef);

      const roleWithoutEndProvenance = {
        provenance,
        recordedAt: timestamp,
        rolePeriodRef,
        roleType: 'CUSTOMER' as const,
        state: 'ACTIVE' as const,
        validFrom: timestamp,
        validTo: null,
      };
      expect(
        yield* Schema.encodeEffect(CounterpartyRolePeriodSchema)(
          yield* Schema.decodeEffect(CounterpartyRolePeriodSchema)(
            roleWithoutEndProvenance
          )
        )
      ).toEqual(roleWithoutEndProvenance);
      expect(
        yield* Schema.encodeEffect(CounterpartyRolePeriodSchema)(
          yield* Schema.decodeEffect(CounterpartyRolePeriodSchema)({
            ...roleWithoutEndProvenance,
            endProvenance: null,
          })
        )
      ).toEqual({ ...roleWithoutEndProvenance, endProvenance: null });
      expect(
        yield* Schema.encodeEffect(CounterpartyAuditEvidenceSchema)(
          yield* Schema.decodeEffect(CounterpartyAuditEvidenceSchema)({
            evidenceReference: null,
            provenanceMethod: provenance.method,
            provenanceReason: provenance.reason,
            provenanceSource: provenance.source,
          })
        )
      ).toEqual({
        evidenceReference: null,
        provenanceMethod: provenance.method,
        provenanceReason: provenance.reason,
        provenanceSource: provenance.source,
      });
      expect(
        yield* Schema.encodeEffect(CounterpartyPartyProjectionSchema)(
          yield* Schema.decodeEffect(CounterpartyPartyProjectionSchema)({
            archived: false,
            canonicalPartyRef: partyRef,
            displayName: null,
            partyType: 'ORGANIZATION',
            storedPartyRef: partyRef,
          })
        )
      ).toEqual({
        archived: false,
        canonicalPartyRef: partyRef,
        displayName: null,
        partyType: 'ORGANIZATION',
        storedPartyRef: partyRef,
      });
    })
);

it.effect(
  'accepts only CUSTOMER and SUPPLIER role periods with explicit evidence',
  () =>
    Effect.gen(function* contractScenario5() {
      for (const roleType of ['CUSTOMER', 'SUPPLIER'] as const) {
        expect(
          (yield* Schema.decodeEffect(CounterpartyRoleAddPayloadSchema)({
            counterpartyRef,
            provenance,
            roleType,
            validFrom: '2026-09-03T10:00:00.000Z',
          })).roleType
        ).toBe(roleType);
      }
      for (const roleType of ['BUSINESS_PARTNER', 'OTHER']) {
        expect(
          yield* Effect.flip(
            Schema.decodeUnknownEffect(CounterpartyRoleAddPayloadSchema)({
              counterpartyRef,
              provenance,
              roleType,
              validFrom: '2026-09-03T10:00:00.000Z',
            })
          )
        ).toBeDefined();
      }
      for (const validFrom of [
        '2026-02-30T00:00:00.000Z',
        '2026-01-01T00:00:00Z',
      ]) {
        expect(
          yield* Effect.flip(
            Schema.decodeEffect(CounterpartyRoleAddPayloadSchema)({
              counterpartyRef,
              provenance,
              roleType: 'CUSTOMER',
              validFrom,
            })
          )
        ).toBeDefined();
      }
      expect(
        yield* Schema.decodeEffect(CounterpartyRoleAddResultSchema)({
          counterpartyRef,
          rolePeriodRef,
          roleType: 'CUSTOMER',
          validFrom: '2026-09-03T10:00:00.000Z',
          validTo: null,
        })
      ).toEqual({
        counterpartyRef,
        rolePeriodRef,
        roleType: 'CUSTOMER',
        validFrom: '2026-09-03T10:00:00.000Z',
        validTo: null,
      });
      expect(
        (yield* Schema.decodeEffect(CounterpartyRoleAddPayloadSchema)({
          counterpartyRef,
          provenance: {
            evidenceReference: provenance.evidenceReference,
            method: provenance.method,
            source: provenance.source,
          },
          roleType: 'CUSTOMER',
          validFrom: '2026-09-03T10:00:00.000Z',
        })).provenance.reason
      ).toBe(undefined);
    })
);

it.effect(
  'ends one named role period without deleting Counterparty history',
  () =>
    Effect.gen(function* contractScenario6() {
      const payload = yield* Schema.decodeEffect(
        CounterpartyRoleEndPayloadSchema
      )({
        counterpartyRef,
        provenance,
        rolePeriodRef,
        validTo: '2027-01-31T23:59:59.000Z',
      });
      expect(payload).toEqual({
        counterpartyRef,
        provenance,
        rolePeriodRef,
        validTo: '2027-01-31T23:59:59.000Z',
      });
      expect(
        (yield* Schema.decodeEffect(CounterpartyRoleEndResultSchema)({
          counterpartyRef,
          rolePeriodRef,
          roleType: 'SUPPLIER',
          validFrom: '2026-09-03T10:00:00.000Z',
          validTo: '2027-01-31T23:59:59.000Z',
        })).validTo
      ).toBe('2027-01-31T23:59:59.000Z');
      expect(
        (yield* Schema.decodeEffect(CounterpartyRoleEndPayloadSchema)({
          counterpartyRef,
          provenance: {
            evidenceReference: provenance.evidenceReference,
            method: 'CONFIRMED_SUPPLIER_RELATIONSHIP_END',
            source: provenance.source,
          },
          rolePeriodRef,
          validTo: '2027-01-31T23:59:59.000Z',
        })).provenance.reason
      ).toBe(undefined);
    })
);

it.effect(
  'publishes a minimum Party projection and keeps full role history separate',
  () =>
    Effect.gen(function* contractScenario7() {
      const request = yield* Schema.decodeEffect(CounterpartyReadRequestSchema)(
        {
          counterpartyRef,
        }
      );
      expect(request).toEqual({ counterpartyRef });
      const currentRole = {
        provenance,
        recordedAt: '2026-09-03T10:01:00.000Z',
        rolePeriodRef,
        roleType: 'CUSTOMER',
        state: 'ACTIVE',
        validFrom: '2026-09-03T10:00:00.000Z',
        validTo: null,
      } as const;
      const result = yield* Schema.decodeEffect(
        CounterpartyReadResponseSchema,
        {
          onExcessProperty: 'error',
        }
      )({
        counterpartyRef,
        createdAt: '2026-09-03T10:00:00.000Z',
        currentRoles: [currentRole],
        legalEntityRef,
        party: {
          archived: false,
          canonicalPartyRef: partyRef,
          displayName: 'ACME s.r.o.',
          partyType: 'ORGANIZATION',
          storedPartyRef: partyRef,
        },
      });
      expect(result.party.displayName).toBe('ACME s.r.o.');
      expect(
        (yield* Schema.decodeEffect(CounterpartyReadResponseSchema)({
          ...result,
          party: { ...result.party, displayName: null },
        })).party.displayName
      ).toBe(null);
      expect(result.currentRoles.map(({ roleType }) => roleType)).toEqual([
        'CUSTOMER',
      ]);
      expect(
        (yield* Schema.decodeEffect(CounterpartyReadResponseSchema)({
          ...result,
          currentRoles: [],
        })).currentRoles
      ).toEqual([]);
      expect(
        yield* Effect.flip(
          Schema.decodeUnknownEffect(CounterpartyReadResponseSchema, {
            onExcessProperty: 'error',
          })({
            ...result,
            party: { ...result.party, contactPoints: [] },
          })
        )
      ).toBeDefined();

      expect(
        yield* Schema.decodeEffect(CounterpartyRoleHistoryRequestSchema)({
          counterpartyRef,
        })
      ).toEqual({ counterpartyRef });
      expect(
        (yield* Schema.decodeEffect(CounterpartyRoleHistoryResponseSchema)({
          counterpartyRef,
          roles: [
            {
              ...currentRole,
              state: 'ENDED',
              validTo: '2027-01-31T23:59:59.000Z',
            },
          ],
        })).roles[0]?.state
      ).toBe('ENDED');
      expect(counterpartyReadRead.descriptor.permissionTarget).toBe('resource');
      expect(counterpartyRoleHistoryRead.descriptor.permissionTarget).toBe(
        'resource'
      );
      expect(counterpartyReadRead.descriptor.legalEntityScope).toBe('optional');
      expect(counterpartyRoleHistoryRead.descriptor.legalEntityScope).toBe(
        'optional'
      );
      expect(counterpartyReadPermissionTarget({ counterpartyRef })).toEqual({
        kind: 'any_of',
        targets: [
          {
            kind: 'resource',
            resource: {
              moduleId: 'party.registry',
              resourceId: counterpartyId,
              resourceType: 'party.registry.counterparty',
            },
          },
          { kind: 'tenant', permission: 'manage_party_identity' },
        ],
      });
      expect(
        counterpartyRoleHistoryPermissionTarget({ counterpartyRef })
      ).toEqual(counterpartyReadPermissionTarget({ counterpartyRef }));
    })
);
