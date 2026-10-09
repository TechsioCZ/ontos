import {
  PriceCatalogTargetAssessmentSchema,
  PriceCatalogTargetSchema,
  PriceProductTargetSnapshotSchema,
} from '@app/pricing-contracts/domain/catalog-price-target';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogProductTargetSnapshot,
  CatalogSelectionEvidence,
  CatalogTargetAdministrationRejected,
  ExactCatalogTargetCommandExecution,
  makeCatalogTargetAdministration,
} from '../../src/services/catalog-target-administration.service.ts';
import type {
  CatalogProductTargetSnapshotPort,
  CatalogSelectionEvidencePort,
  ExactCatalogTargetCommandPort,
} from '../../src/services/catalog-target-administration.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const capturedAt = '2026-09-27T10:00:00.000Z';

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const otherProductRef = catalogRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'commerce.catalog.product');
const firstVariantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const secondVariantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');
const laterVariantRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.variant');

const targetFor = (variantRef: typeof firstVariantRef) =>
  Schema.decodeSync(PriceCatalogTargetSchema)({ productRef, variantRef });

const catalogEvidenceFor = (target: ReturnType<typeof targetFor>) => {
  const variantRevision = { resourceRef: target.variantRef, revision: 2 };
  return {
    assessedAt: capturedAt,
    basis: [
      { role: 'PRODUCT' as const, source: { resourceRef: target.productRef, revision: 1 } },
      { role: 'VARIANT' as const, source: variantRevision },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
        role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
        source: { resourceRef: target.productRef, revision: 1 },
      },
    ],
    membership: {
      attestationId: `catalog-membership:${target.variantRef.resourceId}`,
      observedAt: capturedAt,
      productRef: target.productRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: variantRevision,
    },
    purpose: 'PRICING' as const,
    selection: target,
    status: 'VALID' as const,
  };
};

const acceptedAssessmentFor = (target: ReturnType<typeof targetFor>) =>
  Schema.decodeSync(PriceCatalogTargetAssessmentSchema)({
    catalogEvidence: catalogEvidenceFor(target),
    outcome: 'PRICE_CATALOG_TARGET_ACCEPTED',
    target,
  });

const firstTarget = targetFor(firstVariantRef);
const secondTarget = targetFor(secondVariantRef);
const laterTarget = targetFor(laterVariantRef);

const snapshotFor = (targets = [firstTarget, secondTarget], snapshotId = 'catalog-product-snapshot:17') =>
  Schema.decodeSync(PriceProductTargetSnapshotSchema)({
    capturedAt,
    catalogOwnerRevision: 'catalog-product-active-variants:17',
    productRef,
    snapshotId,
    targets: targets.map((target) => ({
      catalogEvidence: catalogEvidenceFor(target),
      target,
      targetId: `catalog-target:${target.variantRef.resourceId}`,
    })),
    targetSetCompleteness: {
      observedAt: capturedAt,
      ownerRevision: 'catalog-product-active-variants:17',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-product:active-variants' },
    },
  });

const makeAcceptanceService = (ports: {
  readonly assessment: CatalogSelectionEvidencePort;
  readonly command: ExactCatalogTargetCommandPort;
  readonly snapshot: CatalogProductTargetSnapshotPort;
}) =>
  makeCatalogTargetAdministration.pipe(
    Effect.provideService(CatalogSelectionEvidence, ports.assessment),
    Effect.provideService(ExactCatalogTargetCommandExecution, ports.command),
    Effect.provideService(CatalogProductTargetSnapshot, ports.snapshot),
  );

describe('Pricing Catalog target administration acceptance', () => {
  it.effect('accepts only the exact Catalog-assessed target and fails closed on a substituted Variant', () =>
    Effect.gen(function* exactAssessment() {
      const exactService = yield* makeAcceptanceService({
        assessment: { assessExactTarget: (target) => Effect.succeed(acceptedAssessmentFor(target)) },
        command: { executeExactTarget: () => Effect.succeed('unused') },
        snapshot: { captureProductTargetSnapshot: () => Effect.succeed(snapshotFor()) },
      });
      expect(yield* exactService.assessExactTarget(firstTarget)).toMatchObject({
        outcome: 'PRICE_CATALOG_TARGET_ACCEPTED',
        target: firstTarget,
      });

      const substitutingService = yield* makeAcceptanceService({
        assessment: { assessExactTarget: () => Effect.succeed(acceptedAssessmentFor(secondTarget)) },
        command: { executeExactTarget: () => Effect.succeed('unused') },
        snapshot: { captureProductTargetSnapshot: () => Effect.succeed(snapshotFor()) },
      });
      const error = yield* Effect.flip(substitutingService.assessExactTarget(firstTarget));
      expect(error).toBeInstanceOf(CatalogTargetAdministrationRejected);
      if (Schema.is(CatalogTargetAdministrationRejected)(error)) {
        expect(error.code).toBe('ASSESSMENT_TARGET_MISMATCH');
      }
    }),
  );

  it.effect('rejects a Product snapshot returned for another Product parent', () =>
    Effect.gen(function* parentage() {
      const snapshot = snapshotFor();
      const service = yield* makeAcceptanceService({
        assessment: { assessExactTarget: (target) => Effect.succeed(acceptedAssessmentFor(target)) },
        command: { executeExactTarget: () => Effect.succeed('unused') },
        snapshot: { captureProductTargetSnapshot: () => Effect.succeed(snapshot) },
      });
      const error = yield* Effect.flip(service.captureProductTargetSnapshot(otherProductRef));
      expect(error).toBeInstanceOf(CatalogTargetAdministrationRejected);
      if (Schema.is(CatalogTargetAdministrationRejected)(error)) {
        expect(error.code).toBe('SNAPSHOT_PRODUCT_MISMATCH');
      }
    }),
  );

  it.effect('executes the fixed snapshot without re-expanding to a later Variant', () =>
    Effect.gen(function* fixedSnapshot() {
      const captured = snapshotFor([firstTarget, secondTarget]);
      const laterObservation = snapshotFor([firstTarget, secondTarget, laterTarget], 'catalog-product-snapshot:18');
      const executedTargetIds: string[] = [];
      let captureCount = 0;
      const service = yield* makeAcceptanceService({
        assessment: { assessExactTarget: (target) => Effect.succeed(acceptedAssessmentFor(target)) },
        command: {
          executeExactTarget: ({ identity }) =>
            Effect.sync(() => {
              executedTargetIds.push(identity.targetId);
              return `defined:${identity.targetId}`;
            }),
        },
        snapshot: {
          captureProductTargetSnapshot: () =>
            Effect.sync(() => {
              captureCount += 1;
              return captureCount === 1 ? captured : laterObservation;
            }),
        },
      });

      const originallyCaptured = yield* service.captureProductTargetSnapshot(productRef);
      yield* service.captureProductTargetSnapshot(productRef);
      const result = yield* service.executeProductTargetSnapshot({
        intent: { amount: '100' },
        snapshot: originallyCaptured,
      });

      expect(executedTargetIds).toEqual(captured.targets.map(({ targetId }) => targetId));
      expect(executedTargetIds).not.toContain(laterObservation.targets[2]?.targetId);
      expect(result.outcomes).toHaveLength(2);
    }),
  );

  it.effect('does not let an unverified prior-success claim suppress any target command', () =>
    Effect.gen(function* rejectUnverifiedRecovery() {
      const snapshot = snapshotFor();
      const executed: string[] = [];
      const service = yield* makeAcceptanceService({
        assessment: { assessExactTarget: (target) => Effect.succeed(acceptedAssessmentFor(target)) },
        command: {
          executeExactTarget: ({ identity }) =>
            Effect.sync(() => {
              executed.push(identity.targetId);
              return `defined:${identity.targetId}`;
            }),
        },
        snapshot: { captureProductTargetSnapshot: () => Effect.succeed(snapshot) },
      });
      const callerInputWithUnverifiedRecoveryClaim = {
        intent: { amount: '100' },
        priorSuccessfulTargets: [
          {
            snapshotId: snapshot.snapshotId,
            target: snapshot.targets[0]?.target,
            targetId: snapshot.targets[0]?.targetId,
          },
        ],
        snapshot,
      };
      const result = yield* service.executeProductTargetSnapshot(callerInputWithUnverifiedRecoveryClaim);

      expect(result.snapshotId).toBe(snapshot.snapshotId);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['TARGET_SUCCEEDED', 'TARGET_SUCCEEDED']);
      expect(executed).toEqual(snapshot.targets.map(({ targetId }) => targetId));
    }),
  );

  it.effect('rejects stale or ORDER_HISTORY snapshot evidence before invoking any command', () =>
    Effect.gen(function* rejectUntrustedSnapshot() {
      const snapshot = snapshotFor();
      let commandCalls = 0;
      const service = yield* makeAcceptanceService({
        assessment: { assessExactTarget: (target) => Effect.succeed(acceptedAssessmentFor(target)) },
        command: {
          executeExactTarget: () =>
            Effect.sync(() => {
              commandCalls += 1;
              return 'must-not-run';
            }),
        },
        snapshot: { captureProductTargetSnapshot: () => Effect.succeed(snapshot) },
      });
      const wrongPurposeSnapshot = {
        ...snapshot,
        targets: snapshot.targets.map((entry) => ({
          ...entry,
          catalogEvidence: { ...entry.catalogEvidence, purpose: 'ORDER_HISTORY' },
        })),
      };
      const purposeError = yield* Effect.flip(
        service.executeProductTargetSnapshot({
          intent: { amount: '100' },
          snapshot: wrongPurposeSnapshot,
        }),
      );
      const staleAt = '2026-09-27T09:59:59.000Z';
      const staleSnapshot = {
        ...snapshot,
        targets: snapshot.targets.map((entry) => ({
          ...entry,
          catalogEvidence: {
            ...entry.catalogEvidence,
            assessedAt: staleAt,
            membership: { ...entry.catalogEvidence.membership, observedAt: staleAt },
          },
        })),
      };
      const staleError = yield* Effect.flip(
        service.executeProductTargetSnapshot({ intent: { amount: '100' }, snapshot: staleSnapshot }),
      );

      expect(purposeError).toBeInstanceOf(CatalogTargetAdministrationRejected);
      expect(purposeError.code).toBe('SNAPSHOT_EVIDENCE_MISMATCH');
      expect(staleError).toBeInstanceOf(CatalogTargetAdministrationRejected);
      expect(staleError.code).toBe('SNAPSHOT_EVIDENCE_MISMATCH');
      expect(commandCalls).toBe(0);
    }),
  );

  it.effect('is invariant to application or Storefront context outside the owner input', () =>
    Effect.gen(function* applicationInvariance() {
      const requestedFromWeb = { applicationId: 'shop-web', storefrontId: 'storefront-cz', target: firstTarget };
      const requestedFromStaff = { applicationId: 'staff-admin', storefrontId: 'staff', target: firstTarget };
      const service = yield* makeAcceptanceService({
        assessment: { assessExactTarget: (target) => Effect.succeed(acceptedAssessmentFor(target)) },
        command: { executeExactTarget: () => Effect.succeed('unused') },
        snapshot: { captureProductTargetSnapshot: () => Effect.succeed(snapshotFor()) },
      });

      const web = yield* service.assessExactTarget(requestedFromWeb.target);
      const staff = yield* service.assessExactTarget(requestedFromStaff.target);
      expect(web).toEqual(staff);
      expect(web).not.toHaveProperty('applicationId');
      expect(web).not.toHaveProperty('storefrontId');
    }),
  );
});
