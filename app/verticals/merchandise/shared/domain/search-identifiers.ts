import { Schema } from 'effect';

export const SearchLegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('SelectedLegalEntityId'),
);
export const SearchRebuildRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('SearchRebuildRequestId'),
);
