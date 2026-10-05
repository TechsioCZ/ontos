import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AvailabilityDeliveryBoundarySchema,
  availabilityDeliveryBoundary,
} from '../../shared/domain/availability-delivery-boundary.ts';
import { AvailabilityDecisionOutcomeSchema } from '../../shared/domain/availability-owner-ports.ts';
import { AvailabilitySubjectSchema } from '../../shared/domain/availability-subject.ts';

// Controlled boundary fixture, not an alternative Availability evaluator or delivery owner.
const retainedEvaluationSchema = Schema.Struct({
  deliveryBoundary: AvailabilityDeliveryBoundarySchema,
  evidenceRef: Schema.String,
  outcome: AvailabilityDecisionOutcomeSchema,
});
const decode = Schema.decodeUnknownSync(retainedEvaluationSchema, { onExcessProperty: 'error' });
const currentPositive = {
  deliveryBoundary: availabilityDeliveryBoundary,
  evidenceRef: 'controlled-current-owner-evidence',
  outcome: 'AVAILABLE',
};

describe('Availability general promise and downstream delivery boundary', () => {
  it('retains a positive prospective promise before any exact address or delivery choice exists', () => {
    expect(decode(currentPositive)).toEqual(currentPositive);
    expect(Object.keys(AvailabilitySubjectSchema.fields)).toEqual(['purchasingContext', 'quantity', 'selection']);
    expect(decode(currentPositive)).not.toHaveProperty('destination');
    expect(decode(currentPositive)).not.toHaveProperty('carrier');
    expect(decode(currentPositive)).not.toHaveProperty('deliveryMethod');
  });

  it('rejects stronger destination, carrier or execution guarantees and physical prerequisites', () => {
    for (const boundary of [
      { ...availabilityDeliveryBoundary, exactDestination: 'DELIVERABLE' },
      { ...availabilityDeliveryBoundary, carrierAndMethod: 'COMPATIBLE' },
      { ...availabilityDeliveryBoundary, fulfillmentExecution: 'GUARANTEED' },
      { ...availabilityDeliveryBoundary, physicalDeliveryPrerequisite: 'REQUIRED' },
    ]) {
      expect(() => decode({ ...currentPositive, deliveryBoundary: boundary })).toThrow();
    }
    expect(() => decode({ ...currentPositive, finalDeliveryDestinationResult: 'SUCCESS' })).toThrow();
  });

  it('preserves the historical AVAILABLE evaluation after a later exact-address non-success', () => {
    const historical = decode(currentPositive);
    const retained = structuredClone(historical);
    const downstreamDestinationDecision = { outcome: 'NON_SUCCESS', reason: 'NO_CARRIER_FOR_EXACT_ADDRESS' };

    expect(downstreamDestinationDecision.outcome).toBe('NON_SUCCESS');
    expect(historical).toEqual(retained);
    expect(historical.outcome).toBe('AVAILABLE');
    expect(historical.deliveryBoundary.exactDestination).toBe('NOT_ASSESSED');
  });

  it('allows pickup success and shipping non-success to accompany the same retained Availability', () => {
    const historical = decode(currentPositive);
    const downstreamChoices = { pickup: 'SUCCESS', shipping: 'NON_SUCCESS' };

    expect(downstreamChoices.pickup).not.toBe(downstreamChoices.shipping);
    expect(historical).toEqual(decode(currentPositive));
    expect(historical.deliveryBoundary.carrierAndMethod).toBe('NOT_ASSESSED');
  });

  it('permits controlled digital and service promises without physical destination, carrier or shipment', () => {
    for (const evidenceRef of [
      'controlled-current-digital-owner-evidence',
      'controlled-current-service-owner-evidence',
    ]) {
      const evaluation = decode({ ...currentPositive, evidenceRef });

      expect(evaluation.outcome).toBe('AVAILABLE');
      expect(evaluation.deliveryBoundary.physicalDeliveryPrerequisite).toBe('NOT_REQUIRED');
      expect(evaluation).not.toHaveProperty('shipment');
      expect(evaluation).not.toHaveProperty('supplierPromise');
    }
  });
});
