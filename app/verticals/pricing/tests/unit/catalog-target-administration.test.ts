import {
  PriceCatalogTargetAssessmentSchema,
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
  CatalogTargetDependencyFailure,
  ExactCatalogTargetCommand,
} from '../../src/services/catalog-target-administration.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const firstVariantId = '33333333-3333-4333-8333-333333333333';
const secondVariantId = '44444444-4444-4444-8444-444444444444';
const laterVariantId = '55555555-5555-4555-8555-555555555555';
const observedAt = '2026-09-27T10:00:00.000Z';

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef(productId, 'commerce.catalog.product');
const targetFor = (variantId: string) => ({
  productRef,
  variantRef: catalogRef(variantId, 'commerce.catalog.variant'),
});

const catalogEvidenceFor = (target: ReturnType<typeof targetFor>, purpose = 'PRICING') => {
  const variantRevision = { resourceRef: target.variantRef, revision: 2 };
  return {
    assessedAt: observedAt,
    basis: [
      { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
      { role: 'VARIANT' as const, source: variantRevision },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
        role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
        source: { resourceRef: productRef, revision: 1 },
      },
    ],
    membership: {
      attestationId: `membership:${target.variantRef.resourceId}`,
      observedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: variantRevision,
    },
    purpose,
    selection: target,
    status: 'VALID' as const,
  };
};

const firstTarget = targetFor(firstVariantId);
const secondTarget = targetFor(secondVariantId);
const laterTarget = targetFor(laterVariantId);

const decodeAssessment = Schema.decodeUnknownSync(PriceCatalogTargetAssessmentSchema, {
  onExcessProperty: 'error',
});
const decodeSnapshot = Schema.decodeUnknownSync(PriceProductTargetSnapshotSchema, {
  onExcessProperty: 'error',
});

const snapshotFor = (targets = [firstTarget, secondTarget]) =>
  decodeSnapshot({
    capturedAt: observedAt,
    catalogOwnerRevision: 'catalog-product-active-variants:17',
    productRef,
    snapshotId: 'catalog-product-snapshot:17',
    targets: targets.map((target) => ({
      catalogEvidence: catalogEvidenceFor(target),
      target,
      targetId: target.variantRef.resourceId,
    })),
    targetSetCompleteness: {
      observedAt,
      ownerRevision: 'catalog-product-active-variants:17',
      scope: {
        kind: 'EXACT_PREDICATE',
        predicateRef: `commerce.catalog.product.active-variants:${tenantId}:${productId}`,
      },
    },
  });

type Command = ExactCatalogTargetCommand;

const makeService = (input?: {
  readonly assessment?: ReturnType<typeof decodeAssessment>;
  readonly command?: (command: Command) => Effect.Effect<{ readonly receipt: string }, CatalogTargetDependencyFailure>;
  readonly snapshot?: ReturnType<typeof snapshotFor>;
}) =>
  makeCatalogTargetAdministration.pipe(
    Effect.provideService(CatalogSelectionEvidence, {
      assessExactTarget: () =>
        Effect.succeed(
          input?.assessment ??
            decodeAssessment({
              catalogEvidence: catalogEvidenceFor(firstTarget),
              outcome: 'PRICE_CATALOG_TARGET_ACCEPTED',
              target: firstTarget,
            }),
        ),
    }),
    Effect.provideService(ExactCatalogTargetCommandExecution, {
      executeExactTarget:
        input?.command ?? ((command) => Effect.succeed({ receipt: `receipt:${command.identity.targetId}` })),
    }),
    Effect.provideService(CatalogProductTargetSnapshot, {
      captureProductTargetSnapshot: () => Effect.succeed(input?.snapshot ?? snapshotFor()),
    }),
  );

describe('Pricing Catalog target administration', () => {
  it.effect('accepts only Catalog evidence issued for the exact Pricing target', () =>
    Effect.gen(function* validateExactEvidence() {
      const defaultService = yield* makeService();
      const accepted = yield* defaultService.assessExactTarget(firstTarget);
      expect(accepted.outcome).toBe('PRICE_CATALOG_TARGET_ACCEPTED');

      const substituted = decodeAssessment({
        catalogEvidence: catalogEvidenceFor(secondTarget),
        outcome: 'PRICE_CATALOG_TARGET_ACCEPTED',
        target: secondTarget,
      });
      const substitutedService = yield* makeService({ assessment: substituted });
      const substitutionFailure = yield* Effect.flip(substitutedService.assessExactTarget(firstTarget));
      expect(substitutionFailure).toBeInstanceOf(CatalogTargetAdministrationRejected);
      if (Schema.is(CatalogTargetAdministrationRejected)(substitutionFailure)) {
        expect(substitutionFailure.code).toBe('ASSESSMENT_TARGET_MISMATCH');
      }

      const wrongPurpose = decodeAssessment({
        catalogEvidence: catalogEvidenceFor(firstTarget, 'ORDER_HISTORY'),
        outcome: 'PRICE_CATALOG_TARGET_ACCEPTED',
        target: firstTarget,
      });
      const wrongPurposeService = yield* makeService({ assessment: wrongPurpose });
      const purposeFailure = yield* Effect.flip(wrongPurposeService.assessExactTarget(firstTarget));
      expect(purposeFailure).toBeInstanceOf(CatalogTargetAdministrationRejected);
      if (Schema.is(CatalogTargetAdministrationRejected)(purposeFailure)) {
        expect(purposeFailure.code).toBe('ASSESSMENT_PURPOSE_MISMATCH');
      }
    }),
  );

  it.effect('binds Product administration to the requested owner-issued snapshot', () =>
    Effect.gen(function* captureFixedSnapshot() {
      const defaultService = yield* makeService();
      const captured = yield* defaultService.captureProductTargetSnapshot(productRef);
      expect(captured.targets.map(({ targetId }) => targetId)).toEqual([firstVariantId, secondVariantId]);

      const otherProductRef = catalogRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'commerce.catalog.product');
      const failure = yield* Effect.flip(defaultService.captureProductTargetSnapshot(otherProductRef));
      expect(failure).toBeInstanceOf(CatalogTargetAdministrationRejected);
      if (Schema.is(CatalogTargetAdministrationRejected)(failure)) {
        expect(failure.code).toBe('SNAPSHOT_PRODUCT_MISMATCH');
      }

      const staleAssessedAt = '2026-09-27T09:59:59.000Z';
      const validSnapshot = snapshotFor();
      const staleEvidenceSnapshot = {
        ...validSnapshot,
        targets: validSnapshot.targets.map((entry) => ({
          ...entry,
          catalogEvidence: {
            ...entry.catalogEvidence,
            assessedAt: staleAssessedAt,
            membership: { ...entry.catalogEvidence.membership, observedAt: staleAssessedAt },
          },
        })),
      };
      const staleService = yield* makeService({ snapshot: staleEvidenceSnapshot });
      const staleFailure = yield* Effect.flip(staleService.captureProductTargetSnapshot(productRef));
      expect(staleFailure).toBeInstanceOf(CatalogTargetAdministrationRejected);
      if (Schema.is(CatalogTargetAdministrationRejected)(staleFailure)) {
        expect(staleFailure.code).toBe('SNAPSHOT_EVIDENCE_MISMATCH');
      }
    }),
  );

  it.effect('executes every fixed target independently and reports partial success in snapshot order', () =>
    Effect.gen(function* executeIndependentTargets() {
      const commands: Command[] = [];
      const service = yield* makeService({
        command: (command) => {
          commands.push(command);
          return command.identity.targetId === secondVariantId
            ? Effect.fail({ _tag: 'TARGET_CONFLICT' })
            : Effect.succeed({ receipt: `receipt:${command.identity.targetId}` });
        },
      });
      const snapshot = snapshotFor();
      const result = yield* service.executeProductTargetSnapshot({
        intent: { changeId: 'price-change:1' },
        snapshot,
      });

      expect(result.snapshotId).toBe(snapshot.snapshotId);
      expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(['TARGET_SUCCEEDED', 'TARGET_FAILED']);
      expect(commands.map(({ identity }) => identity)).toEqual(
        snapshot.targets.map(({ target, targetId }) => ({ snapshotId: snapshot.snapshotId, target, targetId })),
      );
      expect(commands.map(({ intent }) => intent)).toEqual([
        { changeId: 'price-change:1' },
        { changeId: 'price-change:1' },
      ]);
    }),
  );

  it.effect('re-executes the original fixed snapshot without trusting caller success claims', () =>
    Effect.gen(function* reexecuteFixedSnapshot() {
      const originalSnapshot = snapshotFor();
      const repeatedCommands: Command[] = [];
      const service = yield* makeService({
        command: (command) => {
          repeatedCommands.push(command);
          return Effect.succeed({ receipt: `receipt:${command.identity.targetId}` });
        },
        snapshot: snapshotFor([firstTarget, secondTarget, laterTarget]),
      });
      const callerInputWithUnverifiedSuccess = {
        intent: { changeId: 'price-change:stable' },
        priorSuccessfulTargets: [
          {
            snapshotId: originalSnapshot.snapshotId,
            target: originalSnapshot.targets[0]?.target,
            targetId: originalSnapshot.targets[0]?.targetId,
          },
        ],
        snapshot: originalSnapshot,
      };
      const repeated = yield* service.executeProductTargetSnapshot(callerInputWithUnverifiedSuccess);

      expect(repeated.outcomes.map(({ outcome }) => outcome)).toEqual(['TARGET_SUCCEEDED', 'TARGET_SUCCEEDED']);
      expect(repeatedCommands).toHaveLength(2);
      expect(repeatedCommands.some(({ identity }) => identity.targetId === laterVariantId)).toBe(false);
    }),
  );

  it.effect('rejects stale or ORDER_HISTORY snapshot evidence before invoking any target command', () =>
    Effect.gen(function* rejectUntrustedSnapshot() {
      let commandCalls = 0;
      const snapshot = snapshotFor();
      const service = yield* makeService({
        command: () => {
          commandCalls += 1;
          return Effect.succeed({ receipt: 'must-not-run' });
        },
      });
      const wrongPurposeSnapshot = {
        ...snapshot,
        targets: snapshot.targets.map((entry) => ({
          ...entry,
          catalogEvidence: { ...entry.catalogEvidence, purpose: 'ORDER_HISTORY' },
        })),
      };
      const purposeFailure = yield* Effect.flip(
        service.executeProductTargetSnapshot({
          intent: { changeId: 'price-change:2' },
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
      const staleFailure = yield* Effect.flip(
        service.executeProductTargetSnapshot({
          intent: { changeId: 'price-change:3' },
          snapshot: staleSnapshot,
        }),
      );

      expect(purposeFailure).toBeInstanceOf(CatalogTargetAdministrationRejected);
      expect(purposeFailure.code).toBe('SNAPSHOT_EVIDENCE_MISMATCH');
      expect(staleFailure).toBeInstanceOf(CatalogTargetAdministrationRejected);
      expect(staleFailure.code).toBe('SNAPSHOT_EVIDENCE_MISMATCH');
      expect(commandCalls).toBe(0);
    }),
  );
});
