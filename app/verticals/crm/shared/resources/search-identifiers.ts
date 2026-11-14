import { Schema } from 'effect';

const SearchTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CrmSearchTenantId'));
const SearchCompanyIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CrmSearchCompanyId'));
const SearchRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CrmSearchRequestId'));

export const SearchTenantIdJsonSchema = Schema.toEncoded(SearchTenantIdSchema);
export const SearchCompanyIdJsonSchema = Schema.toEncoded(SearchCompanyIdSchema);
export const SearchRequestIdJsonSchema = Schema.toEncoded(SearchRequestIdSchema);
