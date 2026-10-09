import type { OperationalScope } from '@app/core-runtime';
import { Cause, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  AssortmentCommitmentConfirmationPayloadSchema,
  AssortmentCommitmentConfirmationResultSchema,
  AssortmentCommitmentConfirmationInvalid,
} from '../../shared/domain/commitment-confirmation.ts';
import {
  AssortmentCandidateSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseConstituentSchema,
} from '../../shared/domain/decision-contracts.ts';
import { assortmentCommitmentConfirmationRepositoryFromPort } from '../../src/services/assortment-commitment-confirmation.repository.ts';
import type {
  AssortmentCommitmentConfirmationPersistencePort,
  CommitmentConfirmationInsert,
  ConfirmationRow,
} from '../../src/services/assortment-commitment-confirmation.repository.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const legalEntityId = 'sle-1';
const principalId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a13';
const invocationId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a14';
const ref = (moduleId: string, resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({ moduleId, resourceId, resourceType, tenantId });
// Future consumer owners define these types; Assortment persists both references opaquely.
const attemptRef = ref('example.consumer', 'example.consumer.attempt', 'attempt-1');
const meaningRef = ref('example.consumer', 'example.consumer.prospective-purchase-meaning', 'meaning-1');
const productRef = ref('catalog.owner', 'catalog.product', 'product-1');
const variantRef = ref('catalog.owner', 'catalog.variant', 'variant-1');
const candidate = Schema.decodeUnknownSync(AssortmentCandidateSchema)({
  audience: { kind: 'SHARED' },
  bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-1'),
  commercialScope: {
    channelRef: ref('commerce.channel', 'commerce.channel.channel', 'web'),
    sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', legalEntityId),
  },
  decisionPurpose: 'PURCHASE',
  effect: 'ALLOW',
  ruleRevision: {
    ownerModuleId: 'commerce.assortment',
    revision: 'r1',
    sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-1'),
  },
  selector: { kind: 'VARIANT', variantRef },
  stableRuleRef: ref('commerce.assortment', 'commerce.assortment.stable-rule', 'rule-1'),
});
const constituent = Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
  catalogSelection: { configuration: { kind: 'NONE' }, productRef, variantKind: 'ATOMIC', variantRef },
  role: 'TOP_LEVEL',
});
const payload = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationPayloadSchema)({
  attemptRef,
  candidate,
  constituent,
  decisionEvidenceRef: {
    evidenceRef: ref('commerce.assortment', 'commerce.assortment.decision-evidence', 'evidence-1'),
    ownerModuleId: 'commerce.assortment',
  },
  prospectivePurchaseMeaningRef: meaningRef,
});
const issuedAt = '2026-09-24T10:00:00.000Z';
const confirmation = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationResultSchema)({
  ...payload,
  confirmationRef: ref('commerce.assortment', 'commerce.assortment.commitment-confirmation', 'confirmation-1'),
  expiresAt: '2026-09-24T10:00:30.000Z',
  issuedAt,
});
const scope = {
  authContextRef: 'confirmation-repository-test',
  authMethod: 'session',
  correlationId: 'confirmation-repository-test',
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope;
const metadata = { actionInvocationId: invocationId, actorPrincipalId: principalId };

const replayPort = (): AssortmentCommitmentConfirmationPersistencePort => {
  let insertedValues: CommitmentConfirmationInsert | undefined;
  let insertCount = 0;
  return {
    findByInvocation: () =>
      Effect.succeed(
        insertedValues === undefined
          ? []
          : [
              {
                ...insertedValues,
                commitmentConfirmationId: confirmation.confirmationRef.resourceId,
              } satisfies ConfirmationRow,
            ],
      ),
    insert: (value) => {
      const inserted = insertCount === 0;
      if (inserted) {
        insertedValues = value;
      }
      insertCount += 1;
      return Effect.succeed(inserted);
    },
  };
};

it.effect('replays immutable confirmation by invocation and rejects changed payload or actor', () =>
  Effect.gen(function* repositoryReplay() {
    const repository = assortmentCommitmentConfirmationRepositoryFromPort(replayPort(), scope);
    const first = yield* repository.persist(payload, confirmation, scope, metadata);
    expect(first).toEqual(confirmation);

    const replay = yield* repository.persist(
      payload,
      Schema.decodeUnknownSync(AssortmentCommitmentConfirmationResultSchema)({
        ...confirmation,
        confirmationRef: ref('commerce.assortment', 'commerce.assortment.commitment-confirmation', 'confirmation-2'),
        expiresAt: '2026-09-24T10:00:20.000Z',
        issuedAt,
      }),
      scope,
      metadata,
    );
    expect(replay).toEqual(first);

    const changedActor = yield* Effect.exit(
      repository.persist(payload, confirmation, scope, {
        ...metadata,
        actorPrincipalId: '018f8b4e-35a2-7b51-8d56-91a4f37d6a15',
      }),
    );
    expect(Exit.isFailure(changedActor)).toBe(true);
    if (Exit.isFailure(changedActor)) {
      const failure = changedActor.cause.reasons.find(Cause.isFailReason);
      expect(failure).toBeDefined();
      if (failure !== undefined) {
        expect(Schema.is(AssortmentCommitmentConfirmationInvalid)(failure.error)).toBe(true);
      }
    }

    const changedPayload = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationPayloadSchema)({
      ...payload,
      prospectivePurchaseMeaningRef: ref(
        'example.consumer',
        'example.consumer.prospective-purchase-meaning',
        'meaning-2',
      ),
    });
    const changedPayloadResult = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationResultSchema)({
      ...changedPayload,
      confirmationRef: ref('commerce.assortment', 'commerce.assortment.commitment-confirmation', 'confirmation-3'),
      expiresAt: '2026-09-24T10:00:30.000Z',
      issuedAt,
    });
    const changedPayloadExit = yield* Effect.exit(
      repository.persist(changedPayload, changedPayloadResult, scope, metadata),
    );
    expect(Exit.isFailure(changedPayloadExit)).toBe(true);
    if (Exit.isFailure(changedPayloadExit)) {
      const failure = changedPayloadExit.cause.reasons.find(Cause.isFailReason);
      expect(failure).toBeDefined();
      if (failure !== undefined) {
        expect(Schema.is(AssortmentCommitmentConfirmationInvalid)(failure.error)).toBe(true);
      }
    }
  }),
);
