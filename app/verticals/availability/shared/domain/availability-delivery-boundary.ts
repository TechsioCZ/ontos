import { Schema } from 'effect';

/**
 * Every Availability outcome concerns the general prospective purchase promise.
 * AVAILABLE supports selling and generally fulfilling the exact requested purchase;
 * it does not establish suitability for any particular address or delivery choice.
 *
 * Delivery Destination owns exact postal/pickup suitability. Delivery/Shipping owns
 * carrier and method compatibility. Fulfillment owns capacity and execution.
 * These owners may consume Availability; their final decisions are never its inputs.
 * Digital/service purchases therefore need no invented physical-delivery prerequisite.
 */
export const AvailabilityDeliveryBoundarySchema = Schema.Struct({
  carrierAndMethod: Schema.Literal('NOT_ASSESSED'),
  exactDestination: Schema.Literal('NOT_ASSESSED'),
  fulfillmentExecution: Schema.Literal('NOT_ASSESSED'),
  physicalDeliveryPrerequisite: Schema.Literal('NOT_REQUIRED'),
  promiseScope: Schema.Literal('GENERAL_PROSPECTIVE_PURCHASE'),
});
export type AvailabilityDeliveryBoundary = typeof AvailabilityDeliveryBoundarySchema.Type;

/**
 * Attach this value to retained decisions, never a downstream delivery result.
 * Later address/carrier failures cannot change the meaning of the historical decision.
 * No supplier/service authority is introduced here; positive evidence retains its owner.
 */
export const availabilityDeliveryBoundary: AvailabilityDeliveryBoundary = {
  carrierAndMethod: 'NOT_ASSESSED',
  exactDestination: 'NOT_ASSESSED',
  fulfillmentExecution: 'NOT_ASSESSED',
  physicalDeliveryPrerequisite: 'NOT_REQUIRED',
  promiseScope: 'GENERAL_PROSPECTIVE_PURCHASE',
};
