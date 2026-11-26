import { Schema } from 'effect';

const unavailableFields = {
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.Literal('provider_observation_store_unavailable'),
  reason: Schema.String,
};
const unavailableContract = Schema.TaggedStruct('ProviderObservationStoreUnavailable', unavailableFields);

/** The observation could not be recorded or its answer could not be read: the adapter may deliver the same observation again. */
export const ProviderObservationStoreUnavailable = Schema.TaggedError<typeof unavailableContract.Type>()(
  'ProviderObservationStoreUnavailable',
  unavailableFields,
);
