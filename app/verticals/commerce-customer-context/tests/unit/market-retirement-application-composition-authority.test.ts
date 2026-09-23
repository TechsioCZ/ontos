import {
  ActiveApplicationCompositionSnapshotSchema,
  ActiveApplicationCompositionUnavailableError,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseAssessmentResponse,
} from '@app/customer-market-retirement-contracts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority } from '../../api/application-composition-market-reference-owner-authority.ts';
import { makeMarketAffectedUseAssessmentServices } from '../../src/api/market-affected-use-assessment.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const evaluatedAt = '2026-09-22T10:00:00.000Z';
const revision = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: 'market-cz',
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const request: MarketAffectedUseAssessmentRequest = {
  evaluatedAt,
  marketRef,
  marketRevision: 7,
  tenantId,
};
const localAssessment: MarketAffectedUseAssessmentResponse = {
  assessmentDigest: digest,
  evaluatedAt,
  liveBlockingReferences: { bootstrapDefaults: [], currentProposals: [] },
  marketRef,
  marketRevision: 7,
  observedAt: '2026-09-22T09:59:00.000Z',
  outcome: 'VERIFIED',
  retainedHistoryReferences: [],
  sourceEvidence: [],
  tenantId,
};

const module = (moduleId: 'commerce.cart' | 'commerce.order') => ({
  allowedContributions: [],
  contract: { sha256: 'c'.repeat(64), url: `https://${moduleId}.example.test/contract.json` },
  dependencies: [],
  deployment: { appId: moduleId.replace('.', '-'), buildMarker: `${moduleId}-build-1` },
  federation: {
    execution: 'browser' as const,
    exposes: [],
    manifest: { sha256: 'd'.repeat(64), url: `https://${moduleId}.example.test/mf-manifest.json` },
    remoteName: moduleId === 'commerce.cart' ? 'commerceCart' : 'commerceOrder',
  },
  moduleId,
  publicContract: { id: moduleId, sha256: 'e'.repeat(64), version: '1' },
  requiredCoreCapabilities: [],
  requiredShellAbi: { id: 'ontos.shell-contributions', version: '1' },
  sharedSingletons: [],
});

const snapshot = (
  modules: readonly ReturnType<typeof module>[] = [],
  observedAt = '2026-09-22T09:59:00.000Z',
  validUntil = '2026-09-22T10:01:00.000Z',
): ActiveApplicationCompositionSnapshot =>
  Schema.decodeUnknownSync(ActiveApplicationCompositionSnapshotSchema)({
    composition: {
      modules,
      revision,
      schemaVersion: '1',
      shell: {
        contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
        coreCapabilities: [],
        sharedSingletons: [],
      },
    },
    observedAt,
    validUntil,
  });

it.effect('proves absent Cart and Order as UNIMPLEMENTED against the active composition revision', () =>
  Effect.gen(function* absentOwners() {
    const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(
      Effect.succeed(snapshot()),
    );
    const result = yield* authority.proveReferenceOwnerStates(request);

    expect(result.sourceEvidence.map(({ sourceId }) => sourceId)).toEqual([
      'application-composition:commerce.cart:UNIMPLEMENTED',
      'application-composition:commerce.order:UNIMPLEMENTED',
    ]);
    for (const evidence of result.sourceEvidence) {
      expect(evidence.ownerRevision).toBe(revision);
      expect(evidence.generation).toBe(revision);
      expect(evidence.completenessEvidence.ownerRevision).toBe(revision);
      expect(evidence.completenessEvidence.scope.kind).toBe('SAFELY_BROADER_SCOPE');
      if (evidence.completenessEvidence.scope.kind === 'SAFELY_BROADER_SCOPE') {
        expect(evidence.completenessEvidence.scope.declaredScopeRef).toBe(`application-composition:${revision}`);
      }
    }
  }),
);

it.effect('fails closed when a Market-reference owner is installed without its affected-use provider', () =>
  Effect.gen(function* installedOwner() {
    const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(
      Effect.succeed(snapshot([module('commerce.cart')])),
    );
    const failure = yield* authority.proveReferenceOwnerStates(request).pipe(Effect.flip);

    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('commerce.cart');
    expect(failure.reason).toContain('installed');
  }),
);

it.effect('fails closed when active Application Composition authority is unavailable', () =>
  Effect.gen(function* unavailableAuthority() {
    const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(
      Effect.fail(
        new ActiveApplicationCompositionUnavailableError({ reason: 'Active revision source is unavailable' }),
      ),
    );
    const failure = yield* authority.proveReferenceOwnerStates(request).pipe(Effect.flip);

    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('Application Composition');
  }),
);

for (const testCase of [
  {
    label: 'future-observed',
    snapshot: snapshot([], '2026-09-22T10:00:01.000Z', '2026-09-22T10:01:00.000Z'),
  },
  {
    label: 'expired',
    snapshot: snapshot([], '2026-09-22T09:58:00.000Z', '2026-09-22T10:00:00.000Z'),
  },
] as const) {
  it.effect(`maps ${testCase.label} composition evidence to STALE instead of safe retirement`, () =>
    Effect.gen(function* staleCompositionEvidence() {
      const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(
        Effect.succeed(testCase.snapshot),
      );
      const services = makeMarketAffectedUseAssessmentServices(
        () => Effect.succeed(localAssessment),
        authority.proveReferenceOwnerStates,
      );

      const result = yield* services.assess(request);

      expect(result.outcome).toBe('STALE');
      if (result.outcome === 'STALE') {
        expect(result.staleSourceIds).toEqual([
          'application-composition:commerce.cart:UNIMPLEMENTED',
          'application-composition:commerce.order:UNIMPLEMENTED',
        ]);
      }
    }),
  );
}
