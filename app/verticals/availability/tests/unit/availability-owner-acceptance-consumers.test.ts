import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Layer, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  AvailabilityConsumerRequestSchema,
  AvailabilityConsumerResponseSchema,
} from '../../shared/domain/availability-consumer-contract.ts';
import { AvailabilityConsumerOwner } from '../../shared/domain/availability-consumer-owner-port.ts';
import type { AvailabilityCurrentDecision } from '../../shared/domain/availability-currentness.ts';
import type { AvailabilityEvaluationInput } from '../../shared/domain/availability-decision.ts';
import {
  availabilityConsumerContractService,
  availabilityConsumerCurrentnessLive,
} from '../../src/services/availability-consumer-contract.service.ts';
import { makeCurrentnessInput } from '../support/availability-currentness.ts';
import {
  acceptanceLater,
  acceptanceObservedAt,
  currentRequest,
  evaluateCurrent,
  ownerProof,
} from '../support/availability-owner-acceptance.ts';

const seller = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const consumerInput = (available = '3'): AvailabilityEvaluationInput => {
  const base = makeCurrentnessInput([available], '2');
  const verification = base.subject.purchasingContext.contextVerification;
  const subject = {
    ...base.subject,
    purchasingContext: {
      contextVerification: {
        ...verification,
        evidence: {
          ...verification.evidence,
          verifiedScope: { ...verification.evidence.verifiedScope, legalEntityId: seller },
        },
        request: {
          ...verification.request,
          purchasingContext: { ...verification.request.purchasingContext, sellingLegalEntityId: seller },
        },
      },
    },
  };
  return {
    ...base,
    ownerQualification: { ...base.ownerQualification, subject },
    policy: { ...base.policy, subject },
    subject,
  };
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authContextRef: 'acceptance-session',
    authMethod: 'session',
    legalEntityId: seller,
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId: consumerInput().subject.selection.productRef.tenantId,
  }),
  correlationId: 'owner-consumer-acceptance',
};
const publicRequest = (input: AvailabilityEvaluationInput, requestedUse = 'ORDER_COMMITMENT') =>
  Schema.decodeUnknownSync(AvailabilityConsumerRequestSchema)({
    contextResolutionRef: 'trusted-commerce-request',
    quantity: input.subject.quantity,
    representedInBundle: false,
    requestedUse,
    selection: input.subject.selection,
  });
const consumerOwner = (
  input: AvailabilityEvaluationInput,
  previous?: AvailabilityCurrentDecision,
): typeof AvailabilityConsumerOwner.Service => ({
  readCurrent: () => Effect.succeed(input),
  resolve: (request) => {
    const resolved = {
      evaluatedAt: acceptanceLater,
      representedInBundle: request.representedInBundle,
      subject: input.subject,
      useBoundary: { kind: request.requestedUse, requiredAt: acceptanceLater },
    };
    return Effect.succeed(previous === undefined ? resolved : { ...resolved, previous });
  },
  verify: ({ evidence, useBoundary }) => Effect.succeed(ownerProof(evidence, useBoundary)),
});
const handoff = (input: AvailabilityEvaluationInput, owner = consumerOwner(input), request = publicRequest(input)) =>
  availabilityConsumerContractService(request, scope).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(AvailabilityConsumerOwner, owner),
        availabilityConsumerCurrentnessLive.pipe(Layer.provide(Layer.succeed(AvailabilityConsumerOwner, owner))),
      ),
    ),
  );
const retainedPositive = (input: AvailabilityEvaluationInput) =>
  evaluateCurrent(
    { ...currentRequest(input, undefined, 'INFORMATIONAL'), evaluatedAt: acceptanceObservedAt },
    ({ evidence, useBoundary }) => Effect.succeed(ownerProof(evidence, useBoundary)),
    input,
  ).pipe(Effect.map((result) => result.currentDecision));

// Controlled downstream observations are never Availability inputs or downstream implementations.
describe('Availability owner acceptance: consumer and delivery boundaries', () => {
  it.effect('scenario 18: later destination failure preserves owner evaluation and historical handoff', () =>
    Effect.gen(function* destinationHistory() {
      const input = consumerInput();
      const previous = yield* retainedPositive(input);
      const before = JSON.stringify(previous);
      const first = yield* handoff(input);
      expect(first.currentDecision.outcome).toBe('AVAILABLE');
      expect(first.currentDecision.authority).toBe('CURRENT_EXACT_USE');
      expect(first.currentDecision.deliveryBoundary.exactDestination).toBe('NOT_ASSESSED');
      expect(first.currentDecision).not.toHaveProperty('destination');
      const laterDestination = { outcome: 'NON_SUCCESS', reason: 'EXACT_ADDRESS_UNDELIVERABLE' };
      expect(() =>
        Schema.decodeUnknownSync(AvailabilityConsumerRequestSchema, { onExcessProperty: 'error' })({
          ...publicRequest(input),
          destinationDecision: laterDestination,
        }),
      ).toThrow();
      const response = yield* handoff(input, consumerOwner(input, previous));
      expect(response.currentDecision.outcome).toBe('AVAILABLE');
      expect(response.originalDecision?.authority).toBe('HISTORICAL_ONLY');
      expect(response.originalDecision?.outcome).toBe('AVAILABLE');
      expect(response.originalDecision?.deliveryBoundary).toEqual(first.currentDecision.deliveryBoundary);
      expect(JSON.stringify(previous)).toBe(before);
      const encoded = yield* Schema.encodeEffect(AvailabilityConsumerResponseSchema)(response);
      expect(yield* Schema.decodeEffect(AvailabilityConsumerResponseSchema)(encoded)).toEqual(response);
    }),
  );

  it.effect('scenario 19: shipping failure and pickup success consume the same general promise', () =>
    Effect.gen(function* methodBoundary() {
      const input = consumerInput();
      let ownerReads = 0;
      const owner = {
        ...consumerOwner(input),
        readCurrent: () => {
          ownerReads += 1;
          return Effect.succeed(input);
        },
      };
      const shipping = { kind: 'SHIPPING', outcome: 'NON_SUCCESS' };
      const pickup = { kind: 'PICKUP', outcome: 'SUCCESS' };
      const first = yield* handoff(input, owner);
      for (const downstreamMethod of [shipping, pickup]) {
        expect(() =>
          Schema.decodeUnknownSync(AvailabilityConsumerRequestSchema, { onExcessProperty: 'error' })({
            ...publicRequest(input),
            downstreamMethod,
          }),
        ).toThrow();
      }
      const second = yield* handoff(input, owner);
      expect(ownerReads).toBe(2);
      expect(first.currentDecision.outcome).toBe('AVAILABLE');
      expect(second.currentDecision).toEqual(first.currentDecision);
      expect(second.currentDecision.deliveryBoundary.carrierAndMethod).toBe('NOT_ASSESSED');
      expect(second.currentDecision.deliveryBoundary.fulfillmentExecution).toBe('NOT_ASSESSED');
    }),
  );

  for (const [kind, suffix] of [
    ['digital', '1'],
    ['service', '2'],
  ] as const) {
    it.effect(`scenario 20: controlled ${kind} Selection needs no physical destination or carrier`, () =>
      Effect.gen(function* nonphysicalSelection() {
        const base = consumerInput();
        const selection = {
          productRef: {
            ...base.subject.selection.productRef,
            resourceId: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee${suffix}`,
          },
          variantRef: {
            ...base.subject.selection.variantRef,
            resourceId: `ffffffff-ffff-4fff-8fff-fffffffffff${suffix}`,
          },
        };
        const subject = { ...base.subject, selection };
        const stockInput = {
          ...base.stockInput,
          positions: base.stockInput.positions.map((position) => ({
            ...position,
            binding: { ...position.binding, catalogSelection: selection },
          })),
        };
        const input = {
          ...base,
          ownerQualification: { ...base.ownerQualification, stockInput, subject },
          policy: { ...base.policy, subject },
          stockInput,
          subject,
        };
        const response = yield* handoff(input);
        expect(response.currentDecision.selection).toEqual(selection);
        expect(response.currentDecision.outcome).toBe('AVAILABLE');
        expect(response.currentDecision.deliveryBoundary).toEqual({
          carrierAndMethod: 'NOT_ASSESSED',
          exactDestination: 'NOT_ASSESSED',
          fulfillmentExecution: 'NOT_ASSESSED',
          physicalDeliveryPrerequisite: 'NOT_REQUIRED',
          promiseScope: 'GENERAL_PROSPECTIVE_PURCHASE',
        });
        expect(response.currentDecision).not.toHaveProperty('carrier');
        expect(response.currentDecision).not.toHaveProperty('shipment');
      }),
    );
  }

  it.effect('scenario 21: stale Search hits and omitted results cannot override fresh Availability authority', () =>
    Effect.gen(function* searchProjection() {
      for (const [projected, available, expected] of [
        ['UNAVAILABLE', '3', 'AVAILABLE'],
        ['AVAILABLE', '0', 'UNAVAILABLE'],
        ['OMITTED', '3', 'AVAILABLE'],
      ] as const) {
        const input = consumerInput(available);
        const previous = yield* retainedPositive(consumerInput());
        let ownerReads = 0;
        const owner = {
          ...consumerOwner(input),
          readCurrent: () => {
            ownerReads += 1;
            return Effect.succeed(input);
          },
        };
        expect(() =>
          Schema.decodeUnknownSync(AvailabilityConsumerRequestSchema, { onExcessProperty: 'error' })({
            ...publicRequest(input),
            searchProjection: { currentness: 'STALE', outcome: projected, result: previous },
          }),
        ).toThrow();
        const response = yield* handoff(input, owner);
        expect(ownerReads).toBe(1);
        expect(response.currentDecision.outcome).toBe(expected);
        expect(response.currentDecision.authority).toBe('CURRENT_EXACT_USE');
        expect(response.currentDecision.reservationProof).toBe('NOT_PROVIDED');
        expect(response.currentDecision.quantity).toEqual(input.subject.quantity);
        expect(response.currentDecision.selection).toEqual(input.subject.selection);
        expect(response.currentDecision.materialEvidence.map((proof) => proof.owner)).toEqual([
          'CATALOG',
          'COMMERCE_PURCHASING_CONTEXT',
          'ASSORTMENT',
          'INVENTORY',
          'AVAILABILITY_POLICY',
        ]);
        const encoded = yield* Schema.encodeEffect(AvailabilityConsumerResponseSchema)(response);
        for (const privateField of ['stockInput', 'rawProviderPayload', 'backendId', 'sourceEvidence', 'positionRef']) {
          expect(JSON.stringify(encoded)).not.toContain(privateField);
        }
      }
      const input = consumerInput();
      const informational = yield* handoff(input, consumerOwner(input), publicRequest(input, 'INFORMATIONAL'));
      expect(informational.currentDecision.outcome).toBe('AVAILABLE');
      expect(informational.currentDecision.authority).toBe('INFORMATIONAL_ONLY');
      const uncertain = yield* handoff(input, {
        ...consumerOwner(input),
        verify: () => Effect.succeed({ _tag: 'UNPROVEN' as const, reason: 'SEARCH_IS_NOT_OWNER_PROOF' }),
      });
      expect(uncertain.currentDecision.outcome).toBe('INDETERMINATE');
      expect(uncertain.currentDecision.authority).toBe('UNPROVEN');
      expect(uncertain.currentDecision.materialEvidence).toEqual([]);
    }),
  );

  it.effect('scenario 22: Repeat Order revalidates exact demand and retains old positive only as history', () =>
    Effect.gen(function* repeatPurchase() {
      const oldInput = consumerInput();
      const previous = yield* retainedPositive(oldInput);
      const history = JSON.stringify(previous);
      const input = consumerInput('0');
      let freshReads = 0;
      let verifications = 0;
      const verify: typeof AvailabilityConsumerOwner.Service.verify = ({ evidence, useBoundary }) => {
        verifications += 1;
        const onHand = evidence.stockInput.positions[0]?.position.onHand;
        return Effect.succeed(
          Match.value(onHand).pipe(
            Match.tag('CURRENT', (current) => current.quantity.amount === '0'),
            Match.orElse(() => false),
          )
            ? ownerProof(evidence, useBoundary, 'R2')
            : { _tag: 'INVALID' as const, reason: 'REPEAT_PURCHASE_STOCK_CHANGED' },
        );
      };
      const owner = {
        ...consumerOwner(input, previous),
        readCurrent: () => {
          freshReads += 1;
          return Effect.succeed(input);
        },
        verify,
      };
      const response = yield* handoff(input, owner, { ...publicRequest(input), previousResultRef: 'old-order-result' });
      expect(freshReads).toBe(1);
      expect(verifications).toBe(2);
      expect(response.currentDecision.outcome).toBe('UNAVAILABLE');
      expect(response.currentDecision.authority).toBe('CURRENT_EXACT_USE');
      expect(response.currentDecision.selection).toEqual(previous.decision.subject.selection);
      expect(response.currentDecision.quantity).toEqual(previous.decision.subject.quantity);
      expect(response.originalDecision?.authority).toBe('HISTORICAL_ONLY');
      expect(response.originalDecision?.outcome).toBe('AVAILABLE');
      expect(JSON.stringify(previous)).toBe(history);
      expect(response.currentDecision.materialEvidence.every((proof) => proof.sourceRevisionRefs.includes('R2'))).toBe(
        true,
      );
    }),
  );
});
