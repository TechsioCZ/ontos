import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessResult, ContextAccessService } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Context, DateTime, Effect, Exit, Layer, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { PartySearchProjectionGateway } from '../../shared/domain/search-projection-gateway.ts';
import type { PartySearchProjectionGatewayService } from '../../shared/domain/search-projection-gateway.ts';
import { CurrentPartySearchTimeSchema } from '../../shared/domain/search-semantics.ts';
import type { CurrentPartySearchEvidence } from '../../shared/domain/search-semantics.ts';
import {
  counterpartiesRead,
  finishCounterpartySearch,
  loadCounterpartySearch,
} from '../../src/search/counterparties.provider.ts';
import {
  authorizeCurrentPartySearchEvidence,
  finishPartySearch,
  loadPartySearch,
  partiesRead,
} from '../../src/search/parties.provider.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const tenantScope = {
  authMethod: 'system',
  authContextRef: 'job:party-search:run:provider-test',
  correlationId: 'party-search-provider-test',
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
} as const;
const legalEntityScope = { ...tenantScope, legalEntityId } as const;
const noCurrentEvidence = () => Effect.succeed({ aliases: [], identities: [] });

const partyId = '40000000-0000-4000-8000-000000000001';
const aliasId = '40000000-0000-4000-8000-000000000002';
const counterpartyId = '50000000-0000-4000-8000-000000000001';
const partyRef = (resourceId: string) =>
  ({ moduleId: 'party.registry', resourceType: 'party.registry.party', resourceId, tenantId }) as const;
const identity = (id = partyId) => ({
  archived: false,
  contacts: [],
  displayName: 'Jana Nováková',
  identifiers: [],
  ref: partyRef(id),
});
const evidence: CurrentPartySearchEvidence = { aliases: [], identities: [identity()] };
const effectiveAt = Schema.decodeSync(CurrentPartySearchTimeSchema)('2026-11-04T12:00:00.000Z');
const hit = { archived: false, canonicalPartyRef: partyRef(partyId), title: 'Stale projection' };
const accessFor = (decision: (id: string) => ContextAccessResult['decision'] = () => 'allowed') => {
  const calls: Parameters<NonNullable<ContextAccessService['tenantResources']>>[0][] = [];
  const access: ContextAccessService = {
    legalEntities: () => Effect.die('No source permission substitution'),
    modules: () => Effect.die('No source permission substitution'),
    resources: () => Effect.die('Party evidence must never use company resource authority'),
    tenantResources: (input) => {
      calls.push(input);
      return Effect.succeed(
        input.resources.map((ref) => ({
          decision: decision(ref.resourceId),
          key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
        })),
      );
    },
    tenants: () => Effect.die('No source permission substitution'),
  };
  return { access, calls };
};

it.effect('tenant Party authority is identical without a company and with a selected company', () =>
  Effect.gen(function* currentSourceAuthority() {
    for (const scope of [tenantScope, legalEntityScope]) {
      const { access, calls } = accessFor((id) => (id === aliasId ? 'denied' : 'allowed'));
      const current = { ...evidence, identities: [identity(), identity(aliasId)] };
      const allowed = yield* authorizeCurrentPartySearchEvidence(scope, current).pipe(
        Effect.provideService(ContextAccess, access),
      );
      expect([...allowed]).toEqual([partyId]);
      expect(calls).toEqual([
        {
          permission: 'read',
          principalId: tenantScope.principalId,
          resources: [partyRef(partyId), partyRef(aliasId)].map(({ tenantId: _tenant, ...ref }) => ref),
          tenantId,
        },
      ]);
      expect(calls[0]).not.toHaveProperty('legalEntityId');
    }
  }),
);

it.effect('absent or unavailable tenant capability fails closed without company-authority fallback', () =>
  Effect.gen(function* missingTenantCapability() {
    const { tenantResources: _tenantResources, ...missing } = accessFor().access;
    for (const access of [missing, accessFor(() => 'unavailable').access]) {
      for (const scope of [tenantScope, legalEntityScope]) {
        const error = yield* finishPartySearch({ query: 'Jana' }, scope, { effectiveAt, evidence, hits: [hit] }).pipe(
          Effect.provideService(ContextAccess, access),
          Effect.flip,
        );
        expect(error.code).toBe('party_search_projection_unavailable');
      }
    }
    const emptyError = yield* authorizeCurrentPartySearchEvidence(tenantScope, { aliases: [], identities: [] }).pipe(
      Effect.provideService(ContextAccess, missing),
      Effect.flip,
    );
    expect(emptyError.code).toBe('party_search_projection_unavailable');
  }),
);

it.effect('malformed, missing, excess, duplicate and unavailable source decisions fail closed', () =>
  Effect.gen(function* malformedSourceAuthority() {
    const key = `party.registry:party.registry.party:${partyId}`;
    const cases: readonly (readonly ContextAccessResult[])[] = [
      [],
      [{ key: 'wrong', decision: 'allowed' }],
      [
        { key, decision: 'allowed' },
        { key, decision: 'allowed' },
      ],
      [
        { key, decision: 'allowed' },
        { key: 'extra', decision: 'denied' },
      ],
      [{ key, decision: 'unavailable' }],
    ];
    for (const decisions of cases) {
      const error = yield* authorizeCurrentPartySearchEvidence(tenantScope, evidence).pipe(
        Effect.provideService(ContextAccess, {
          ...accessFor().access,
          tenantResources: () => Effect.succeed(decisions),
        }),
        Effect.flip,
      );
      expect(error.code).toBe('party_search_projection_unavailable');
    }
  }),
);

it.effect('Party finishing returns the same empty response for withdrawn, hidden, denied and missing matches', () =>
  Effect.gen(function* lagWindowPrivacy() {
    for (const current of [evidence, { ...evidence, identities: [] }]) {
      expect(
        yield* finishPartySearch({ query: 'withdrawn@example.test' }, tenantScope, {
          effectiveAt,
          evidence: current,
          hits: [hit],
        }).pipe(Effect.provideService(ContextAccess, accessFor().access)),
      ).toEqual([]);
    }
    expect(
      yield* finishPartySearch({ query: 'Jana' }, tenantScope, { effectiveAt, evidence, hits: [hit] }).pipe(
        Effect.provideService(ContextAccess, accessFor(() => 'denied').access),
      ),
    ).toEqual([]);
    expect(
      yield* finishPartySearch({ query: 'Jana' }, tenantScope, { effectiveAt, evidence, hits: [hit] }).pipe(
        Effect.provideService(ContextAccess, accessFor().access),
      ),
    ).toEqual([{ archived: false, matchedViaAlias: false, ref: partyRef(partyId), title: 'Jana Nováková' }]);
  }),
);

it.effect('Counterparty finishing fences the same stale contact evidence and refreshes alias attribution', () =>
  Effect.gen(function* counterpartyLagWindowPrivacy() {
    const counterpartyHit = {
      canonicalPartyRef: partyRef(partyId),
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceType: 'party.registry.counterparty',
        resourceId: counterpartyId,
        tenantId,
      } as const,
      legalEntity: { legalEntityId, tenantId },
      matchedPartyRef: partyRef(aliasId),
      partyArchived: false,
      partyTitle: 'Stale title',
      rolePeriods: [],
    };
    const loaded = { effectiveAt, evidence, hits: [counterpartyHit] };
    expect(
      yield* finishCounterpartySearch(
        { query: 'withdrawn@example.test' },
        legalEntityScope,
        legalEntityId,
        loaded,
      ).pipe(Effect.provideService(ContextAccess, accessFor().access)),
    ).toEqual([]);
    const current = yield* finishCounterpartySearch({ query: 'Jana' }, legalEntityScope, legalEntityId, loaded).pipe(
      Effect.provideService(ContextAccess, accessFor().access),
    );
    expect(current[0]?.party).toEqual({
      archived: false,
      matchedViaAlias: false,
      ref: partyRef(partyId),
      title: 'Jana Nováková',
    });
    const authorization = counterpartiesRead.descriptor.resultAuthorization;
    if (authorization?.kind !== 'search-collection') {
      return yield* Effect.die('Counterparty targets require their separate governed company authorization');
    }
    const selection = yield* authorization.select(current, legalEntityScope);
    const deniedTarget = selection.retain(new Set<string>());
    expect(deniedTarget.result).toEqual([]);
    expect(deniedTarget.resultCount).toBe(0);
  }),
);

it('Party provider declares optional Legal Entity context and tenant Party-read authority', () => {
  expect(partiesRead.descriptor.accessKind).toBe('search');
  expect(partiesRead.descriptor.legalEntityScope).toBe('optional');
  expect(partiesRead.descriptor.permissionTarget).toBe('tenant');
});

it('Counterparty provider requires trusted Legal Entity context and candidate authorization', () => {
  expect(counterpartiesRead.descriptor.accessKind).toBe('search');
  expect(counterpartiesRead.descriptor.legalEntityScope).toBe('required');
  expect(counterpartiesRead.descriptor.permissionTarget).toBe('legal_entity');
});

it.effect('Party provider sends only trusted tenant scope to the Core projection gateway', () =>
  Effect.gen(function* trustedPartyScope() {
    const calls: (readonly [unknown, unknown])[] = [];
    const gateway: PartySearchProjectionGatewayService = {
      searchCounterparties: () => Effect.succeed([]),
      searchParties: (input, scope) =>
        Effect.sync(() => {
          calls.push([input, scope]);
          return [];
        }),
    };

    const result = yield* loadPartySearch(
      gateway,
      tenantScope,
      { includeArchived: true, query: 'ACME' },
      noCurrentEvidence,
    );
    expect(result.hits).toEqual([]);
    expect(result.evidence).toEqual({ aliases: [], identities: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ includeArchived: true, query: 'ACME', tenantId }, tenantScope]);
    expect(calls[0]?.[1]).toBe(tenantScope);
  }),
);

it.effect('Counterparty provider derives Legal Entity from trusted scope and never from payload', () =>
  Effect.gen(function* trustedCounterpartyScope() {
    const calls: unknown[] = [];
    const gateway: PartySearchProjectionGatewayService = {
      searchCounterparties: (input, scope) =>
        Effect.sync(() => {
          calls.push(input);
          expect(scope).toBe(legalEntityScope);
          return [];
        }),
      searchParties: () => Effect.succeed([]),
    };

    const result = yield* loadCounterpartySearch(
      gateway,
      legalEntityScope,
      legalEntityId,
      { includeArchived: false, query: 'ACME', role: 'SUPPLIER' },
      '2026-09-03T12:00:00.000Z',
      noCurrentEvidence,
    );
    expect(result.hits).toEqual([]);
    expect(result.evidence).toEqual({ aliases: [], identities: [] });
    expect(calls).toEqual([
      {
        effectiveAt: '2026-09-03T12:00:00.000Z',
        includeArchived: false,
        legalEntityId,
        query: 'ACME',
        role: 'SUPPLIER',
        tenantId,
      },
    ]);
  }),
);

it.effect('Counterparty provider preserves typed normalization failures and omits an absent role', () =>
  Effect.gen(function* invalidCounterpartyInstant() {
    const calls: unknown[] = [];
    const gateway: PartySearchProjectionGatewayService = {
      searchCounterparties: (input) => {
        calls.push(input);
        return Effect.succeed([]);
      },
      searchParties: () => Effect.succeed([]),
    };
    const error = yield* Effect.flip(
      loadCounterpartySearch(gateway, legalEntityScope, legalEntityId, { query: 'ACME' }, 'invalid', noCurrentEvidence),
    );
    assert.equal(error.code, 'party_search_projection_unavailable');
    assert.equal(error.reason, 'Counterparty Search effective time is invalid');
    assert.deepEqual(calls, [
      {
        effectiveAt: 'invalid',
        includeArchived: false,
        legalEntityId,
        query: 'ACME',
        tenantId,
      },
    ]);
  }),
);

// The public Core test kit executes the real provider factory and owner SQL mapping.
// Scripted persistence deliberately leaves the projected contact hit unchanged after withdrawal.
// This proves runtime wiring, not native PostgreSQL/RLS or a live delivery/performance gate.
it.layer(NodeCrypto.layer)('current Party evidence during projection delivery lag', (suite) => {
  suite.effect('real governed Party Read rematches committed owner state before releasing results', () =>
    Effect.gen(function* governedLagWindow() {
      yield* TestClock.setTime(DateTime.toEpochMillis(effectiveAt));
      const runtimeScope = {
        ...legalEntityScope,
        authBindingId: '60000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:party-current-search',
        authMethod: 'session',
      } as const;
      const counterpartyHit = {
        canonicalPartyRef: partyRef(partyId),
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceType: 'party.registry.counterparty',
          resourceId: counterpartyId,
          tenantId,
        } as const,
        legalEntity: { legalEntityId, tenantId },
        partyArchived: false,
        partyTitle: 'Stale projection',
        rolePeriods: [],
      };
      const gateway: PartySearchProjectionGatewayService = {
        searchCounterparties: () => Effect.succeed([counterpartyHit]),
        searchParties: (_input, actualScope) => {
          expect(actualScope.tenantId).toBe(tenantId);
          expect(actualScope.legalEntityId).toBe(legalEntityId);
          return Effect.succeed([hit]);
        },
      };
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: (query) => {
          expect(query.scope).toEqual({ legalEntityId, tenantId });
          expect(query.params).toContain(tenantId);
          expect(query.params).toContain(partyId);
          const sql = query.sql.replaceAll('"party".', '');
          expect(sql).not.toMatch(/limit|offset/iu);
          if (sql.includes('from "party_aliases"')) {
            return Effect.succeed([]);
          }
          if (sql.includes('from "parties"')) {
            return Effect.succeed([
              { archived_at: null, current_display_name: 'Jana Nováková', party_id: partyId, tenant_id: tenantId },
            ]);
          }
          if (sql.includes('from "party_official_identifiers"')) {
            expect(query.params).toContain('ACTIVE');
            expect(sql).toContain('"is_current"');
            return Effect.succeed([]);
          }
          if (sql.includes('from "party_contact_points"')) {
            expect(query.params).toContain('ACTIVE');
            expect(query.params).toContain('PUBLIC');
            expect(query.params).toContain('EMAIL');
            expect(query.params).toContain('PHONE');
            expect(sql).toContain('"is_current"');
            expect(sql).not.toMatch(/address_line|display_value|provenance|verification/iu);
            // Only the current replacement survives the owner predicate; the old contact's
            // outbox delivery has not run and the Core gateway still supplies its stale hit.
            return Effect.succeed([
              {
                isCurrent: true,
                partyId,
                privacy: 'PUBLIC',
                state: 'ACTIVE',
                tenantId,
                type: 'EMAIL',
                validFrom: '2026-01-01T00:00:00.000Z',
                validTo: null,
                value: 'replacement@example.test',
              },
            ]);
          }
          return Effect.die('Unexpected owner evidence query');
        },
        operationTime: DateTime.toDateUtc(effectiveAt),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope: runtimeScope,
      });
      const environment = yield* Layer.build(harness.layer);
      const sourceAuthority = accessFor();
      Object.assign(Context.get(environment, ContextAccess), {
        tenantResources: sourceAuthority.access.tenantResources,
      });
      const run = (query: string) =>
        harness.runtime
          .runRead({
            input: { query },
            principal: runtimeScope,
            registration: partiesRead,
            transport: { correlationId: tenantScope.correlationId },
          })
          .pipe(
            Effect.provideService(ContextAccess, sourceAuthority.access),
            Effect.provideContext(environment),
            Effect.provideService(PartySearchProjectionGateway, gateway),
          );
      const withdrawnResults = yield* Effect.exit(run('withdrawn@example.test'));
      expect(withdrawnResults, Exit.isFailure(withdrawnResults) ? Cause.pretty(withdrawnResults.cause) : '').toEqual(
        Exit.succeed([]),
      );
      expect(yield* run('Jana withdrawn@example.test')).toEqual([]);
      expect(yield* run('Novakova Jana')).toEqual([
        { archived: false, matchedViaAlias: false, ref: partyRef(partyId), title: 'Jana Nováková' },
      ]);
      const replacementMatch = yield* run('replacement@example.test');
      expect(replacementMatch).toEqual([
        { archived: false, matchedViaAlias: false, ref: partyRef(partyId), title: 'Jana Nováková' },
      ]);
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(replacementMatch)).not.toContain(
        'replacement@example.test',
      );
      const runCounterparty = (query: string) =>
        harness.runtime
          .runRead({
            input: { query },
            principal: runtimeScope,
            registration: counterpartiesRead,
            transport: { correlationId: tenantScope.correlationId },
          })
          .pipe(
            Effect.provideService(ContextAccess, sourceAuthority.access),
            Effect.provideContext(environment),
            Effect.provideService(PartySearchProjectionGateway, gateway),
          );
      expect(yield* runCounterparty('withdrawn@example.test')).toEqual([]);
      const counterparties = yield* runCounterparty('Novakova Jana');
      expect(counterparties[0]?.party).toEqual({
        archived: false,
        matchedViaAlias: false,
        ref: partyRef(partyId),
        title: 'Jana Nováková',
      });
      expect(counterparties[0]?.ref).toEqual(counterpartyHit.counterpartyRef);
      expect(harness.snapshot().ownerQueries).toHaveLength(24);
      expect(harness.snapshot().evidenceWrites).toBe(6);
      expect(sourceAuthority.calls).toHaveLength(6);
      expect(sourceAuthority.calls.every((call) => !Object.hasOwn(call, 'legalEntityId'))).toBe(true);
    }),
  );
});
