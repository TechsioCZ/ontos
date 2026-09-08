// @effect-diagnostics nodeBuiltinImport:off -- Source-only contract checks require reading TypeScript files; remove-when: manifests are importable without TSX loaders.
import { expect, it } from '@app/effect-rstest';
import { readFile } from 'node:fs/promises';
import { Effect, Match, Schema, Struct, Predicate } from 'effect';
import {
  PartyMergeReadinessRequestSchema,
  PartyMergeReadinessResponseSchema,
} from '../../shared/apis/party-merge-readiness.ts';
import {
  PartyAliasSchema,
  partyAliasResourceDescriptor,
} from '../../shared/resources/party-alias.ts';
import {
  PartyMergeSchema,
  partyMergeResourceDescriptor,
} from '../../shared/resources/party-merge.ts';
import { partyMergeReadinessRead } from '../../src/api/party-merge-readiness.read.ts';
import {
  analyzePreparedMergeReadiness,
  evaluateDisabledMergeReadiness,
  rejectProductionMergeExecution,
} from '../../src/merge/merge-readiness.ts';
import { selectCanonicalSurvivor } from '../../src/merge/canonical-survivor-selection.ts';
import { partyRegistryApi } from '../../shared/api.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const party = (resourceId: string) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId,
});

it.effect(
  'publishes a tenant-governed read-only readiness contract that always reports execution disabled',
  () =>
    Effect.gen(function* schemaContract1() {
      const request = yield* Schema.decodeUnknownEffect(PartyMergeReadinessRequestSchema, {
        onExcessProperty: 'error',
      })({
        partyRefs: [party('party-a'), party('party-b')],
        policyVersion: 'party-merge-readiness.v1',
      });
      expect(request.partyRefs).toEqual([party('party-a'), party('party-b')]);
      expect(() =>
        Schema.decodeUnknownSync(PartyMergeReadinessRequestSchema)({
          partyRefs: [party('party-a'), party('party-a')],
          policyVersion: 'party-merge-readiness.v1',
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(PartyMergeReadinessRequestSchema)({
          partyRefs: [
            party('party-a'),
            { ...party('party-b'), tenantId: '22222222-2222-4222-8222-222222222222' },
          ],
          policyVersion: 'party-merge-readiness.v1',
        }),
      ).toThrow();
      expect(partyMergeReadinessRead.descriptor).toEqual({
        accessKind: 'detail',
        entrypoint: partyMergeReadinessRead.descriptor.entrypoint,
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'party.registry.api.party-merge-readiness.evidence.v1',
        },
        inputSchema: PartyMergeReadinessRequestSchema,
        legalEntityScope: 'optional',
        owningModuleKey: 'party.registry',
        permissionTarget: 'tenant',
        policies: [],
        readKey: 'party.registry.api.party-merge-readiness',
        resultSchema: PartyMergeReadinessResponseSchema,
        schemaVersion: '1',
      });

      const rejection = rejectProductionMergeExecution();
      expect(Predicate.isTagged(rejection, 'ProductionMergeExecutionRejected')).toBe(true);
      expect(Struct.omit(rejection, ['_tag'])).toEqual({
        code: 'PRODUCTION_MERGE_DISABLED',
        detail:
          'Party Merge execution is disabled until consumer reconciliation and wrong-merge recovery are behaviorally proven.',
      });
      const unavailable = evaluateDisabledMergeReadiness(request.partyRefs);
      expect(unavailable.mergeExecutionEnabled).toBe(false);
      expect(unavailable.analysis).toEqual({
        collisionCodes: [],
        referencePlanStatus: 'PLANNED',
        selectedSurvivorPartyRef: null,
        selectionStatus: 'BLOCKED',
      });
      expect(unavailable.blockers.map(({ code }) => code)).toEqual([
        'PRODUCTION_MERGE_DISABLED',
        'CONSUMER_RECONCILIATION_UNPROVEN',
        'WRONG_MERGE_RECOVERY_UNPROVEN',
        'DUPLICATE_SET_NOT_CONFIRMED',
        'PREPARED_STATE_UNAVAILABLE',
      ]);
    }),
);

it.effect(
  'keeps prepared merge and permanent alias schemas explainable without enabling execution',
  () =>
    Effect.gen(function* schemaContract2() {
      const selection = selectCanonicalSurvivor({
        candidates: ['party-a', 'party-b'].map((id, index) => ({
          authoritativeEvidenceRank: 2 - index,
          blockingAuthoritativeConflict: false,
          completenessRank: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
          lifecycle: 'ACTIVE',
          partyRef: party(id),
          referenceStabilityRank: 1,
        })),
        confirmation: {
          confirmedDuplicateDecisionId: 'decision-1',
          confirmedPartyRefs: [party('party-a'), party('party-b')],
          decisionActorPrincipalId: 'principal-1',
          evidenceRefs: ['evidence-1'],
        },
      });
      const selected = Match.value(selection).pipe(
        Match.tag('CanonicalSurvivorSelected', (value) => value),
        Match.tag('SurvivorSelectionBlocked', ({ blocker }) =>
          ((message: string): never => {
            throw new Error(message);
          })(`Expected canonical survivor selection, but it was blocked: ${blocker}`),
        ),
        Match.exhaustive,
      );
      const merge = yield* Schema.decodeUnknownEffect(PartyMergeSchema)({
        absorbedPartyRefs: [party('party-b')],
        confirmedDuplicateDecisionId: 'decision-1',
        createdAt: '2026-09-03T10:00:00.000Z',
        decisionActorPrincipalId: 'principal-1',
        mergeRef: {
          moduleId: 'party.registry',
          resourceId: 'merge-1',
          resourceType: 'party.registry.party-merge',
          tenantId,
        },
        policyVersion: 'party-merge-readiness.v1',
        selectionEvidenceChain: selected.evidenceChain,
        selectionReason: 'AUTHORITATIVE_EVIDENCE',
        state: 'PREPARED',
        survivorPartyRef: party('party-a'),
      });
      const alias = yield* Schema.decodeUnknownEffect(PartyAliasSchema)({
        aliasPartyRef: party('party-b'),
        createdAt: '2026-09-03T10:00:00.000Z',
        mergeRef: merge.mergeRef,
        survivorPartyRef: party('party-a'),
      });

      expect(merge.state).toBe('PREPARED');
      expect(merge.selectionReason).toBe('AUTHORITATIVE_EVIDENCE');
      expect(merge.selectionEvidenceChain.length).toBe(3);
      expect(merge.selectionEvidenceChain[2]?.candidateSnapshots[0]?.criterionValue).toBe(2);
      expect(() =>
        Schema.decodeUnknownSync(PartyMergeSchema)({
          ...merge,
          selectionEvidenceChain: merge.selectionEvidenceChain.map((step) => ({
            ...step,
            candidateSnapshots: undefined,
          })),
        }),
      ).toThrow();
      expect(alias.aliasPartyRef).toEqual(party('party-b'));
      expect(() =>
        Schema.decodeUnknownSync(PartyMergeSchema)({
          ...merge,
          absorbedPartyRefs: [party('party-a')],
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(PartyMergeSchema)({
          ...merge,
          selectionReason: 'STABLE_RESOURCE_IDENTITY',
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(PartyAliasSchema)({
          ...alias,
          survivorPartyRef: {
            ...party('party-a'),
            tenantId: '22222222-2222-4222-8222-222222222222',
          },
        }),
      ).toThrow();
      expect(partyMergeResourceDescriptor.capabilities.searchable).toBe(false);
      expect(partyAliasResourceDescriptor.capabilities.searchable).toBe(false);
    }),
);

it.effect('has no registered Party Merge Action, event, outbox consumer, or write endpoint', () =>
  Effect.map(
    Effect.all([
      Effect.promise(() =>
        readFile(new URL('../../vertical.manifest.ts', import.meta.url), 'utf-8'),
      ),
      Effect.promise(() =>
        readFile(new URL('../../vertical.registration.ts', import.meta.url), 'utf-8'),
      ),
    ]),
    ([manifestSource, registrationSource]) => {
      expect(manifestSource).not.toMatch(/merge[^\n]*Action|Action[^\n]*merge/iu);
      expect(registrationSource).not.toMatch(/merge[^\n]*Action|Action[^\n]*merge/iu);
      expect(registrationSource).toMatch(/'party-merge-readiness'/u);
      const endpoints = Object.values(partyRegistryApi.groups).flatMap((group) =>
        Object.values(group.endpoints),
      );
      expect(Object.keys(partyRegistryApi.groups.partyCommands.endpoints).length > 0).toBe(true);
      expect(endpoints.filter(({ path }) => /merge/iu.test(path)).map(({ path }) => path)).toEqual([
        '/reads/party-merge-readiness',
      ]);
    },
  ),
);

it.effect('serves the generated OntOS module contract before i18n redirects in development', () =>
  Effect.map(
    Effect.promise(() => readFile(new URL('../../modern.config.ts', import.meta.url), 'utf-8')),
    (modernConfigSource) => {
      expect(modernConfigSource).toMatch(
        /new URL\('\.dev-public\/\.well-known\/ontos-module-manifest\.json', import\.meta\.url\)/u,
      );
      expect(modernConfigSource).toMatch(/setupMiddlewares:/u);
      expect(modernConfigSource).toMatch(
        /request\.url\?\.split\('\?', 1\)\[0\] !== '\/\.well-known\/ontos-module-manifest\.json'/u,
      );
      expect(modernConfigSource).toMatch(
        /response\.setHeader\('Content-Type', 'application\/json'\)/u,
      );
      expect(modernConfigSource).toMatch(/ignoreRedirectRoutes: \[\s*'\/\.well-known'/u);
      expect(modernConfigSource).toMatch(
        /publicDir: \['\.\/locales', '\.\/assets', '\.\/\.dev-public'\]/u,
      );
    },
  ),
);

it.effect('readiness response schema cannot claim production merge is enabled', () =>
  Effect.gen(function* schemaContract3() {
    expect(
      yield* Schema.decodeUnknownEffect(PartyMergeReadinessResponseSchema)({
        analysis: {
          collisionCodes: [],
          referencePlanStatus: 'BLOCKED',
          selectedSurvivorPartyRef: null,
          selectionStatus: 'BLOCKED',
        },
        blockers: [
          {
            code: 'PRODUCTION_MERGE_DISABLED',
            detail: 'Production merge is disabled.',
            ownerKey: 'party.registry',
          },
        ],
        mergeExecutionEnabled: false,
        partyRefs: [party('party-a'), party('party-b')],
        status: 'DISABLED',
      }),
    ).toEqual({
      analysis: {
        collisionCodes: [],
        referencePlanStatus: 'BLOCKED',
        selectedSurvivorPartyRef: null,
        selectionStatus: 'BLOCKED',
      },
      blockers: [
        {
          code: 'PRODUCTION_MERGE_DISABLED',
          detail: 'Production merge is disabled.',
          ownerKey: 'party.registry',
        },
      ],
      mergeExecutionEnabled: false,
      partyRefs: [party('party-a'), party('party-b')],
      status: 'DISABLED',
    });
    expect(() =>
      Schema.decodeUnknownSync(PartyMergeReadinessResponseSchema)({
        analysis: {
          collisionCodes: [],
          referencePlanStatus: 'PLANNED',
          selectedSurvivorPartyRef: party('party-a'),
          selectionStatus: 'SELECTED',
        },
        blockers: [],
        mergeExecutionEnabled: true,
        partyRefs: [party('party-a'), party('party-b')],
        status: 'READY',
      }),
    ).toThrow();
  }),
);

it('readiness invokes survivor, collision, and reference analyzers while remaining disabled', () => {
  const result = analyzePreparedMergeReadiness({
    aliases: [],
    collisionInput: {
      absorbedPartyRefs: [party('unrelated-b')],
      connectorCorrelations: [],
      consumerProfiles: [],
      counterparties: [
        { counterpartyId: 'cp-a', legalEntityId: 'le-1', partyRef: party('party-a') },
        { counterpartyId: 'cp-b', legalEntityId: 'le-1', partyRef: party('party-b') },
      ],
      counterpartyRoles: [],
      officialIdentifiers: [],
      relationships: [],
      survivorPartyRef: party('unrelated-a'),
    },
    consumerReconciliation: [],
    references: [{ class: 'COMMERCE_PROFILE', ownerKey: 'commerce', partyRef: party('party-b') }],
    selectionInput: {
      candidates: [
        {
          authoritativeEvidenceRank: 2,
          blockingAuthoritativeConflict: false,
          completenessRank: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
          lifecycle: 'ACTIVE',
          partyRef: party('party-a'),
          referenceStabilityRank: 2,
        },
        {
          authoritativeEvidenceRank: 1,
          blockingAuthoritativeConflict: false,
          completenessRank: 1,
          createdAt: '2025-01-01T00:00:00.000Z',
          lifecycle: 'ACTIVE',
          partyRef: party('party-b'),
          referenceStabilityRank: 1,
        },
      ],
      confirmation: {
        confirmedDuplicateDecisionId: 'decision-1',
        confirmedPartyRefs: [party('party-a'), party('party-b')],
        decisionActorPrincipalId: 'principal-1',
        evidenceRefs: ['evidence-1'],
      },
    },
  });

  expect(result.status).toBe('DISABLED');
  expect(result.mergeExecutionEnabled).toBe(false);
  expect(result.analysis).toEqual({
    collisionCodes: ['COUNTERPARTY_COLLISION'],
    referencePlanStatus: 'BLOCKED',
    selectedSurvivorPartyRef: party('party-a'),
    selectionStatus: 'SELECTED',
  });
  expect(result.blockers.some(({ code }) => code === 'COUNTERPARTY_COLLISION')).toBe(true);
  expect(result.blockers.some(({ code }) => code === 'CONSUMER_RECONCILIATION_UNPROVEN')).toBe(
    true,
  );
});
