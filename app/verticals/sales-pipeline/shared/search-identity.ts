import { Schema } from 'effect';

export const SearchRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SearchRequestId'));
export const SearchLegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
