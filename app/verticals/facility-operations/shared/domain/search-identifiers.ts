import { Schema } from 'effect';

export const SelectedLegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('FacilitySearchLegalEntityId'),
);
export const SearchRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('FacilitySearchRequestId'));
