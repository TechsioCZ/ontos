import { Result, Schema } from 'effect';
import type { Option } from 'effect';

import { ResourceIdentitySchema } from '../resources/scoped-resource-id.ts';

/**
 * Canonical search resource identity. This is a leaf module: it imports only the platform resource
 * identity schema, so the projection contract, the durable label-refresh contract and the
 * persistence adapter can all share one exact reference without an import cycle.
 */

/** Stable lowercase dotted owner key used for module and resource-type identities. */
export const coreSearchStableKey = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
);

export const coreSearchModuleId = coreSearchStableKey.pipe(Schema.brand('ModuleId'));
export const coreSearchResourceId = ResourceIdentitySchema.pipe(Schema.brand('ResourceId'));
export const coreSearchResourceType = coreSearchStableKey.pipe(Schema.brand('ResourceType'));
export const coreSearchSelectedLegalEntityId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('SelectedLegalEntityId'),
);
export const coreSearchTenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));

export const CoreSearchResourceRefSchema = Schema.Struct({
  moduleId: coreSearchModuleId,
  resourceId: coreSearchResourceId,
  resourceType: coreSearchResourceType,
  tenantId: coreSearchTenantId,
});
export type CoreSearchResourceRef = typeof CoreSearchResourceRefSchema.Type;

const encodeResourceRefKey = Schema.encodeResult(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String])),
);
/** Tuple encoding is unambiguous even for opaque resource IDs containing separators. */
export const coreSearchResourceRefKey = (ref: CoreSearchResourceRef): string =>
  Result.getOrThrow(encodeResourceRefKey([ref.tenantId, ref.moduleId, ref.resourceType, ref.resourceId]));

/**
 * Decode persisted identity columns through the canonical reference schema. The storage boundary must
 * never hand a plain `string` to code that requires a branded reference; a row that does not satisfy
 * the canonical contract decodes to `none` and the caller fails unavailable.
 */
export const decodeCoreSearchResourceRef = (input: {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}): Option.Option<CoreSearchResourceRef> => Schema.decodeUnknownOption(CoreSearchResourceRefSchema)(input);
