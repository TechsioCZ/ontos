import { ContextAccess, toContextPermissionAccessKey } from '@app/core-runtime';
import type { ContextAccessService, OperationalScope } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import type { ReadTestHarnessOptions } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Context, DateTime, Effect, Exit, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import { PartySearchProjectionGateway } from '../../shared/domain/search-projection-gateway.ts';
import type { PartySearchProjectionHit } from '../../shared/domain/search-projection-gateway.ts';
import { partiesRead } from '../../src/search/parties.provider.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const aliasId = '40000000-0000-4000-8000-000000000002';
const previousAliasId = '40000000-0000-4000-8000-000000000003';
const scope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:party-search-persistence',
  authMethod: 'session',
  correlationId: 'party-search-persistence-test',
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
} as const;
const partyRef = (resourceId: string) =>
  ({ moduleId: 'party.registry', resourceType: 'party.registry.party', resourceId, tenantId }) as const;
const hit = {
  archived: false,
  canonicalPartyRef: partyRef(partyId),
  matchedPartyRef: partyRef(aliasId),
  title: 'Stale projection',
};
const partyRow = {
  kind: 'party',
  partyId,
  tenantId,
  archivedAt: null,
  displayName: 'Jana Nováková',
  isCurrent: null,
  privacy: null,
  state: null,
  type: null,
  validFrom: null,
  validTo: null,
  value: null,
};
const aliases = [
  { aliasPartyId: previousAliasId, canonicalPartyId: aliasId, tenantId },
  { aliasPartyId: aliasId, canonicalPartyId: partyId, tenantId },
];

const tenantResources: NonNullable<ContextAccessService['tenantResources']> = ({ resources }) =>
  Effect.succeed(
    resources.map((ref) => ({
      decision: 'allowed' as const,
      key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
    })),
  );
const contextPermissions: NonNullable<ContextAccessService['contextPermissions']> = ({ targets }) =>
  Effect.succeed(
    targets.map((target) => ({
      decision: 'allowed' as const,
      key: toContextPermissionAccessKey(target),
    })),
  );

const runSearch = Effect.fn('PartySearchEvidenceTest.runSearch')(function* runSearch(
  actualScope: OperationalScope,
  hits: readonly PartySearchProjectionHit[],
  executeOwnerQuery: ReadTestHarnessOptions['executeOwnerQuery'],
) {
  const harness = yield* makeReadTestHarness({
    executeOwnerQuery,
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-04T12:00:00.000Z')),
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope: actualScope,
  });
  const environment = yield* Layer.build(harness.layer);
  Object.assign(Context.get(environment, ContextAccess), { contextPermissions, tenantResources });
  const exit = yield* harness.runtime
    .runRead({
      input: { query: 'Jana' },
      principal: actualScope,
      registration: partiesRead,
      transport: { correlationId: actualScope.correlationId },
    })
    .pipe(
      Effect.provideContext(environment),
      Effect.provideService(PartySearchProjectionGateway, {
        searchCounterparties: () => Effect.die('Party Search must not query Counterparties'),
        searchParties: () => Effect.succeed(hits),
      }),
      Effect.exit,
    );
  return { exit, snapshot: harness.snapshot() };
});

it.layer(NodeCrypto.layer)('Party Search scoped evidence persistence', (suite) => {
  suite.effect('loads a multi-hop alias component in two statements with either tenant scope', () =>
    Effect.gen(function* aliasComponent() {
      for (const actualScope of [scope, { ...scope, legalEntityId: '20000000-0000-4000-8000-000000000002' }]) {
        const { exit, snapshot } = yield* runSearch(actualScope, [hit], (query) => {
          expect(query.scope).toEqual({
            legalEntityId: 'legalEntityId' in actualScope ? actualScope.legalEntityId : '',
            tenantId,
          });
          expect(query.params).toContain(tenantId);
          expect(query.sql).not.toMatch(/limit|offset/iu);
          if (query.sql.includes('with recursive party_component')) {
            expect(query.params).toContain(partyId);
            expect(query.params).toContain(aliasId);
            expect(query.sql).toContain('edge.alias_party_id = component.party_id');
            expect(query.sql).toContain('edge.canonical_party_id = component.party_id');
            return Effect.succeed(aliases);
          }
          expect(query.sql.match(/union all/gu)).toHaveLength(2);
          expect(query.sql.indexOf('"party_official_identifiers"')).toBeLessThan(
            query.sql.indexOf('from "party"."parties"'),
          );
          expect(query.params).toContain(previousAliasId);
          expect(query.params).toContain('ACTIVE');
          expect(query.params).toContain(true);
          expect(query.params).toContain('PUBLIC');
          expect(query.params).toContain('EMAIL');
          expect(query.params).toContain('PHONE');
          expect(query.sql).not.toMatch(/address_line|display_value|provenance|verification/iu);
          return Effect.succeed([
            partyRow,
            { ...partyRow, partyId: aliasId, displayName: 'Old name' },
            { ...partyRow, partyId: previousAliasId, displayName: 'Older name' },
          ]);
        });
        expect(exit).toEqual(
          Exit.succeed([{ archived: false, matchedViaAlias: false, ref: partyRef(partyId), title: 'Jana Nováková' }]),
        );
        expect(snapshot.ownerQueries).toHaveLength(2);
        expect(snapshot.evidenceWrites).toBe(1);
      }
    }),
  );

  suite.effect('does not load owner rows when the projection has no candidates', () =>
    Effect.gen(function* emptyCandidates() {
      const { exit, snapshot } = yield* runSearch(scope, [], () =>
        Effect.die('Empty candidates must not query persistence'),
      );
      expect(exit).toEqual(Exit.succeed([]));
      expect(snapshot.ownerQueries).toHaveLength(0);
      expect(snapshot.evidenceWrites).toBe(1);
    }),
  );

  suite.effect('rejects foreign aliases, foreign or disconnected owner rows and malformed evidence', () =>
    Effect.gen(function* invalidEvidence() {
      const foreignTenantId = '10000000-0000-4000-8000-000000000002';
      const cases = [
        { aliases: [{ ...aliases[0], tenantId: foreignTenantId }], rows: [partyRow], queryCount: 1 },
        { aliases: [], rows: [{ ...partyRow, tenantId: foreignTenantId }], queryCount: 2 },
        { aliases: [], rows: [{ ...partyRow, partyId: previousAliasId }], queryCount: 2 },
        {
          aliases: [],
          rows: [{ ...partyRow, kind: 'identifier', isCurrent: true, state: 'ACTIVE', value: '12345678' }],
          queryCount: 2,
        },
      ];
      for (const current of cases) {
        const { exit, snapshot } = yield* runSearch(scope, [hit], (query) =>
          Effect.succeed(query.sql.includes('with recursive party_component') ? current.aliases : current.rows),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(snapshot.ownerQueries).toHaveLength(current.queryCount);
        expect(snapshot.evidenceWrites).toBe(0);
      }
    }),
  );
});
