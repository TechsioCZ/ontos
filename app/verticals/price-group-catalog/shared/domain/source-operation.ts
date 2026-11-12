import { Schema } from 'effect';

const sourceOccurrenceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
export const PriceGroupSourceOccurrenceIdSchema = sourceOccurrenceId.pipe(
  Schema.brand('PriceGroupSourceOccurrenceId'),
  Schema.decodeTo(sourceOccurrenceId),
);

const originalInvocationId = Schema.String.check(Schema.isUUID());
export const PriceGroupBusinessOriginalInvocationIdSchema = originalInvocationId.pipe(
  Schema.brand('PriceGroupBusinessOriginalInvocationId'),
  Schema.decodeTo(originalInvocationId),
);
