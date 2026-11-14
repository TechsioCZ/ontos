import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { Schema } from 'effect';

export const SearchRequestIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SearchRequestId')),
);
export const SelectedLegalEntityIdSchema = LegalEntityRefSchema.fields.resourceId;
