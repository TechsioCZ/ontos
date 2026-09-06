// @effect-diagnostics nodeBuiltinImport:off -- Node's test runner reads source-only contracts; remove-when: manifests are importable without TSX loaders.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Schema } from 'effect';
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

test('publishes a tenant-governed read-only readiness contract that always reports execution disabled', () => {
  const request = Schema.decodeUnknownSync(PartyMergeReadinessRequestSchema, {
    onExcessProperty: 'error',
  })({
    partyRefs: [party('party-a'), party('party-b')],
    policyVersion: 'party-merge-readiness.v1',
  });
  assert.deepEqual(request.partyRefs, [party('party-a'), party('party-b')]);
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyMergeReadinessRequestSchema)({
      partyRefs: [party('party-a'), party('party-a')],
      policyVersion: 'party-merge-readiness.v1',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyMergeReadinessRequestSchema)({
      partyRefs: [
        party('party-a'),
        { ...party('party-b'), tenantId: '22222222-2222-4222-8222-222222222222' },
      ],
      policyVersion: 'party-merge-readiness.v1',
    }),
  );
  assert.deepEqual(partyMergeReadinessRead.descriptor, {
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
  assert.deepEqual(rejection, {
    _tag: 'ProductionMergeExecutionRejected',
    code: 'PRODUCTION_MERGE_DISABLED',
    detail:
      'Party Merge execution is disabled until consumer reconciliation and wrong-merge recovery are behaviorally proven.',
  });
  const unavailable = evaluateDisabledMergeReadiness(request.partyRefs);
  assert.equal(unavailable.mergeExecutionEnabled, false);
  assert.deepEqual(unavailable.analysis, {
    collisionCodes: [],
    referencePlanStatus: 'PLANNED',
    selectedSurvivorPartyRef: null,
    selectionStatus: 'BLOCKED',
  });
  assert.deepEqual(
    unavailable.blockers.map(({ code }) => code),
    [
      'PRODUCTION_MERGE_DISABLED',
      'CONSUMER_RECONCILIATION_UNPROVEN',
      'WRONG_MERGE_RECOVERY_UNPROVEN',
      'DUPLICATE_SET_NOT_CONFIRMED',
      'PREPARED_STATE_UNAVAILABLE',
    ],
  );
});

test('keeps prepared merge and permanent alias schemas explainable without enabling execution', () => {
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
  assert.equal(selection._tag, 'CanonicalSurvivorSelected');
  if (selection._tag !== 'CanonicalSurvivorSelected') {
    return;
  }
  const merge = Schema.decodeUnknownSync(PartyMergeSchema)({
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
    selectionEvidenceChain: selection.evidenceChain,
    selectionReason: 'AUTHORITATIVE_EVIDENCE',
    state: 'PREPARED',
    survivorPartyRef: party('party-a'),
  });
  const alias = Schema.decodeUnknownSync(PartyAliasSchema)({
    aliasPartyRef: party('party-b'),
    createdAt: '2026-09-03T10:00:00.000Z',
    mergeRef: merge.mergeRef,
    survivorPartyRef: party('party-a'),
  });

  assert.equal(merge.state, 'PREPARED');
  assert.equal(merge.selectionReason, 'AUTHORITATIVE_EVIDENCE');
  assert.equal(merge.selectionEvidenceChain.length, 3);
  assert.equal(merge.selectionEvidenceChain[2]?.candidateSnapshots[0]?.criterionValue, 2);
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyMergeSchema)({
      ...merge,
      selectionEvidenceChain: merge.selectionEvidenceChain.map((step) => ({
        ...step,
        candidateSnapshots: undefined,
      })),
    }),
  );
  assert.deepEqual(alias.aliasPartyRef, party('party-b'));
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyMergeSchema)({
      ...merge,
      absorbedPartyRefs: [party('party-a')],
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyMergeSchema)({
      ...merge,
      selectionReason: 'STABLE_RESOURCE_IDENTITY',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyAliasSchema)({
      ...alias,
      survivorPartyRef: {
        ...party('party-a'),
        tenantId: '22222222-2222-4222-8222-222222222222',
      },
    }),
  );
  assert.equal(partyMergeResourceDescriptor.capabilities.searchable, false);
  assert.equal(partyAliasResourceDescriptor.capabilities.searchable, false);
});

test('has no registered Party Merge Action, event, outbox consumer, or write endpoint', () =>
  Promise.all([
    readFile(new URL('../../vertical.manifest.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../vertical.registration.ts', import.meta.url), 'utf-8'),
  ]).then(([manifestSource, registrationSource]) => {
    assert.doesNotMatch(manifestSource, /merge[^\n]*Action|Action[^\n]*merge/iu);
    assert.doesNotMatch(registrationSource, /merge[^\n]*Action|Action[^\n]*merge/iu);
    assert.match(registrationSource, /'party-merge-readiness'/u);
    const endpoints = Object.values(partyRegistryApi.groups).flatMap((group) =>
      Object.values(group.endpoints),
    );
    assert.ok(Object.keys(partyRegistryApi.groups.partyCommands.endpoints).length > 0);
    assert.deepEqual(
      endpoints.filter(({ path }) => /merge/iu.test(path)).map(({ path }) => path),
      ['/reads/party-merge-readiness'],
    );
  }));

test('serves the generated OntOS module contract before i18n redirects in development', () =>
  readFile(new URL('../../modern.config.ts', import.meta.url), 'utf-8').then(
    (modernConfigSource) => {
      assert.match(
        modernConfigSource,
        /new URL\('\.dev-public\/\.well-known\/ontos-module-manifest\.json', import\.meta\.url\)/u,
      );
      assert.match(modernConfigSource, /setupMiddlewares:/u);
      assert.match(
        modernConfigSource,
        /request\.url\?\.split\('\?', 1\)\[0\] !== '\/\.well-known\/ontos-module-manifest\.json'/u,
      );
      assert.match(
        modernConfigSource,
        /response\.setHeader\('Content-Type', 'application\/json'\)/u,
      );
      assert.match(modernConfigSource, /ignoreRedirectRoutes: \[\s*'\/\.well-known'/u);
      assert.match(
        modernConfigSource,
        /publicDir: \['\.\/locales', '\.\/assets', '\.\/\.dev-public'\]/u,
      );
    },
  ));

test('readiness response schema cannot claim production merge is enabled', () => {
  assert.deepEqual(
    Schema.decodeUnknownSync(PartyMergeReadinessResponseSchema)({
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
    {
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
    },
  );
  assert.throws(() =>
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
  );
});

test('readiness invokes survivor, collision, and reference analyzers while remaining disabled', () => {
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

  assert.equal(result.status, 'DISABLED');
  assert.equal(result.mergeExecutionEnabled, false);
  assert.deepEqual(result.analysis, {
    collisionCodes: ['COUNTERPARTY_COLLISION'],
    referencePlanStatus: 'BLOCKED',
    selectedSurvivorPartyRef: party('party-a'),
    selectionStatus: 'SELECTED',
  });
  assert.ok(result.blockers.some(({ code }) => code === 'COUNTERPARTY_COLLISION'));
  assert.ok(result.blockers.some(({ code }) => code === 'CONSUMER_RECONCILIATION_UNPROVEN'));
});
