import { PartyDetailResponseSchema } from '@app/party-registry/api/client';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ManufacturerTargetAbsent,
  ManufacturerTargetForbidden,
  ManufacturerTargetInvalid,
  ManufacturerTargetUnavailable,
  makeManufacturerTargetResolver,
} from '../../src/persistence/manufacturer-target-resolver.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const partyRef = (resourceId: string, tenant = tenantId) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId: tenant,
});
const target = { kind: 'PARTY' as const, partyRef: partyRef('maker-alias') };
const managedTarget = {
  kind: 'LEGAL_ENTITY' as const,
  legalEntityRef: {
    moduleId: 'core.identity' as const,
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'core.identity.legal-entity' as const,
    tenantId,
  },
};
const scope = { requestId: 'catalog-read-1', tenantId };

const detail = (kind: 'ALIAS' | 'DIRECT' = 'ALIAS', archivedAt: string | null = null) =>
  Schema.decodeSync(PartyDetailResponseSchema)({
    currentFactAssertions: [],
    factHistory: null,
    party: {
      archivedAt,
      createdAt: '2026-09-01T00:00:00.000Z',
      displayName: 'Maker',
      partyRef: partyRef(kind === 'ALIAS' ? 'maker-canonical' : 'maker-alias'),
      partyType: 'ORGANIZATION',
      revision: 4,
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
    resolution: {
      aliasChain: kind === 'ALIAS' ? [target.partyRef] : [],
      canonicalPartyRef: partyRef(kind === 'ALIAS' ? 'maker-canonical' : 'maker-alias'),
      kind,
      requestedPartyRef: target.partyRef,
    },
  });

describe('Manufacturer owner target resolution', () => {
  it.effect('uses owner-issued alias and revision, without rewriting the requested relation', () =>
    Effect.gen(function* testAlias() {
      const calls: unknown[] = [];
      const resolver = makeManufacturerTargetResolver({
        readPartyDetail: (payload, requestId) => {
          calls.push({ payload, requestId });
          return Effect.succeed(detail());
        },
      });
      const resolved = yield* resolver.resolve(target, scope);
      expect(resolved).toMatchObject({
        canonicalTarget: { kind: 'PARTY', partyRef: partyRef('maker-canonical') },
        kind: 'PARTY',
        ownerRevision: 4,
        requestedTarget: target,
        state: 'ALIAS',
      });
      expect(calls).toEqual([{ payload: { partyRef: target.partyRef }, requestId: scope.requestId }]);
    }),
  );

  it.effect('distinguishes archived identity from a missing one', () =>
    Effect.gen(function* testArchived() {
      const resolver = makeManufacturerTargetResolver({
        readPartyDetail: () => Effect.succeed(detail('DIRECT', '2026-09-03T00:00:00.000Z')),
      });
      const resolved = yield* resolver.resolve(target, scope);
      expect(resolved.state).toBe('ARCHIVED');
      expect(resolved).toMatchObject({ ownerRevision: 4 });
    }),
  );

  it.effect('rejects foreign Tenant before calling the owner', () =>
    Effect.gen(function* testForeignTenant() {
      let called = false;
      const resolver = makeManufacturerTargetResolver({
        readPartyDetail: () => {
          called = true;
          return Effect.succeed(detail());
        },
      });
      const failure = yield* Effect.flip(
        resolver.resolve({ kind: 'PARTY', partyRef: partyRef('maker', otherTenantId) }, scope),
      );
      expect(Schema.is(ManufacturerTargetInvalid)(failure)).toBe(true);
      expect(called).toBe(false);
    }),
  );

  it.effect('keeps owner absence, denial, and unavailability separate', () =>
    Effect.gen(function* testFailures() {
      for (const [ownerTag, expected] of [
        ['PartyDetailNotFoundProblem', ManufacturerTargetAbsent],
        ['PartyDetailForbiddenProblem', ManufacturerTargetForbidden],
        ['PartyDetailUnavailableProblem', ManufacturerTargetUnavailable],
      ] as const) {
        const resolver = makeManufacturerTargetResolver({
          readPartyDetail: () => Effect.fail({ _tag: ownerTag }),
        });
        const failure = yield* Effect.flip(resolver.resolve(target, scope));
        expect(Schema.is(expected)(failure)).toBe(true);
      }
    }),
  );

  it.effect('fails closed on contradictory owner evidence and on managed Legal Entity before Core read exists', () =>
    Effect.gen(function* testFailClosed() {
      const resolver = makeManufacturerTargetResolver({
        readPartyDetail: () =>
          Effect.succeed({ ...detail(), resolution: { ...detail().resolution, canonicalPartyRef: partyRef('wrong') } }),
      });
      const contradiction = yield* Effect.flip(resolver.resolve(target, scope));
      expect(Schema.is(ManufacturerTargetUnavailable)(contradiction)).toBe(true);
      const managed = yield* Effect.flip(resolver.resolve(managedTarget, scope));
      expect(Schema.is(ManufacturerTargetUnavailable)(managed)).toBe(true);
    }),
  );

  it.effect('accepts exact governed managed identity and retains owner lifecycle', () =>
    Effect.gen(function* testManaged() {
      for (const [status, state] of [
        ['active', 'CURRENT'],
        ['suspended', 'SUSPENDED'],
        ['archived', 'ARCHIVED'],
      ] as const) {
        const resolver = makeManufacturerTargetResolver({
          readManagedLegalEntity: ({ legalEntityRef }) => Effect.succeed({ legalEntityRef, status }),
          readPartyDetail: () => Effect.fail({ _tag: 'PartyDetailUnavailableProblem' }),
        });
        const resolved = yield* resolver.resolve(managedTarget, scope);
        expect(resolved).toMatchObject({
          canonicalTarget: managedTarget,
          kind: 'LEGAL_ENTITY',
          lifecycleStatus: status,
          requestedTarget: managedTarget,
          state,
        });
      }
    }),
  );

  it.effect('rejects contradictory managed identity and maps governed read failures distinctly', () =>
    Effect.gen(function* testManagedFailures() {
      const contradictory = makeManufacturerTargetResolver({
        readManagedLegalEntity: () =>
          Effect.succeed({
            legalEntityRef: { ...managedTarget.legalEntityRef, resourceId: '55555555-5555-4555-8555-555555555555' },
            status: 'active',
          }),
        readPartyDetail: () => Effect.fail({ _tag: 'PartyDetailUnavailableProblem' }),
      });
      const contradiction = yield* Effect.flip(contradictory.resolve(managedTarget, scope));
      expect(Schema.is(ManufacturerTargetUnavailable)(contradiction)).toBe(true);
      for (const [ownerTag, expected] of [
        ['ReadHandlerNotFound', ManufacturerTargetAbsent],
        ['ReadPermissionDenied', ManufacturerTargetForbidden],
        ['ReadPolicyDenied', ManufacturerTargetForbidden],
        ['OperationContextDenied', ManufacturerTargetForbidden],
        ['OperationAuthenticationRequired', ManufacturerTargetForbidden],
        ['ReadHandlerUnavailable', ManufacturerTargetUnavailable],
        ['ReadPermissionUnavailable', ManufacturerTargetUnavailable],
      ] as const) {
        const resolver = makeManufacturerTargetResolver({
          readManagedLegalEntity: () => Effect.fail({ _tag: ownerTag }),
          readPartyDetail: () => Effect.fail({ _tag: 'PartyDetailUnavailableProblem' }),
        });
        const failure = yield* Effect.flip(resolver.resolve(managedTarget, scope));
        expect(Schema.is(expected)(failure)).toBe(true);
      }
    }),
  );
});
