import { createHash } from 'node:crypto';

import {
  ActiveApplicationCompositionSnapshotSchema,
  ActiveApplicationCompositionUnavailableError,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  OntosModuleDeploymentContractSchema,
  ReadHandlerUnavailable,
  buildApplicationCompositionCatalog,
  canonicalizeApplicationComposition,
} from '@app/core-runtime';
import type { ApplicationCompositionModule } from '@app/core-runtime';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '@app/core-runtime/testing/module-contract';
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

const sha256 = (document: string): string => createHash('sha256').update(document, 'utf-8').digest('hex');
const contractJsonSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);

const serverOnlyModule = (moduleId: string, appId: string): ApplicationCompositionModule => {
  const deployment = { appId, buildMarker: `${appId}-build-1` };
  const contractDocument = Schema.encodeSync(contractJsonSchema)(
    makeModuleContractFixture({ ...deployment, moduleId }),
  );
  const contractDigest = sha256(contractDocument);
  return {
    allowedContributions: [],
    backend: { baseUrl: `https://${deployment.buildMarker}.example.test/`, transport: 'node-http' },
    contract: {
      sha256: contractDigest,
      url: `https://${appId}.example.test/.well-known/ontos-module-manifest.json`,
    },
    contractDocument,
    dependencies: [],
    deployment,
    federation: { execution: 'server' },
    moduleId,
    publicContract: { id: moduleId, sha256: contractDigest, version: '2' },
    requiredCoreCapabilities: [],
    requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    sharedSingletons: [],
  };
};

const browserModule = (moduleId: string, appId: string, remoteName: string) => ({
  ...serverOnlyModule(moduleId, appId),
  federation: {
    execution: 'browser' as const,
    exposes: ['./Route'],
    manifest: { sha256: 'd'.repeat(64), url: `https://${appId}.example.test/mf-manifest.json` },
    remoteName,
  },
});

const module = (moduleId: 'commerce.cart' | 'commerce.order') =>
  browserModule(moduleId, moduleId.replace('.', '-'), moduleId === 'commerce.cart' ? 'commerceCart' : 'commerceOrder');

/** Every module the stage topology deploys today, browser remotes and server-only modules alike. */
const currentInventory = [
  browserModule('commerce.catalog', 'catalog', 'verticalCatalog'),
  serverOnlyModule('commerce.customer-context', 'commerce-customer-context'),
  browserModule('commerce.market-catalog', 'commerce-market-catalog', 'verticalCommerceMarketCatalog'),
  serverOnlyModule('commerce.pricing', 'pricing'),
  serverOnlyModule('commerce.storefront-registry', 'storefront-registry'),
  browserModule('party.registry', 'party-registry', 'verticalPartyRegistry'),
  serverOnlyModule('payment.term-catalog', 'payment-term-catalog'),
  serverOnlyModule('pricing.price-group-catalog', 'price-group-catalog'),
];

const snapshot = (
  modules: readonly ApplicationCompositionModule[] = [],
  observedAt = '2026-09-22T09:59:00.000Z',
  validUntil = '2026-09-22T10:01:00.000Z',
) =>
  Effect.gen(function* compositionSnapshotFixture() {
    const fixture = yield* makeApplicationCompositionSnapshotFixture();
    const input = { ...fixture.composition, modules, revision: '0'.repeat(64) };
    const composition = { ...input, revision: sha256(canonicalizeApplicationComposition(input)) };
    yield* buildApplicationCompositionCatalog(composition);
    return yield* Schema.decodeEffect(ActiveApplicationCompositionSnapshotSchema)({
      composition,
      observedAt,
      validUntil,
    });
  });

it.effect('proves absent Cart and Order as UNIMPLEMENTED against the active composition revision', () =>
  Effect.gen(function* absentOwners() {
    const active = yield* snapshot();
    const { revision } = active.composition;
    const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(Effect.succeed(active));
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
    const active = yield* snapshot([module('commerce.cart')]);
    const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(Effect.succeed(active));
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
    observedAt: '2026-09-22T10:00:01.000Z',
    validUntil: '2026-09-22T10:01:00.000Z',
  },
  {
    label: 'expired',
    observedAt: '2026-09-22T09:58:00.000Z',
    validUntil: '2026-09-22T10:00:00.000Z',
  },
] as const) {
  it.effect(`maps ${testCase.label} composition evidence to STALE instead of safe retirement`, () =>
    Effect.gen(function* staleCompositionEvidence() {
      const active = yield* snapshot([], testCase.observedAt, testCase.validUntil);
      const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(Effect.succeed(active));
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

it.effect('proves Cart and Order absent over the complete installed inventory', () =>
  Effect.gen(function* absentOverCompleteInventory() {
    const active = yield* snapshot(currentInventory);
    const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(Effect.succeed(active));
    const result = yield* authority.proveReferenceOwnerStates(request);

    expect(result.sourceEvidence.map(({ sourceId }) => sourceId)).toEqual([
      'application-composition:commerce.cart:UNIMPLEMENTED',
      'application-composition:commerce.order:UNIMPLEMENTED',
    ]);
  }),
);

it.effect('fails closed when a server-only Market-reference owner joins the inventory', () =>
  Effect.gen(function* installedServerOnlyOwner() {
    const active = yield* snapshot([...currentInventory, serverOnlyModule('commerce.order', 'commerce-order')]);
    const authority = makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(Effect.succeed(active));
    const failure = yield* authority.proveReferenceOwnerStates(request).pipe(Effect.flip);

    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('commerce.order');
  }),
);
