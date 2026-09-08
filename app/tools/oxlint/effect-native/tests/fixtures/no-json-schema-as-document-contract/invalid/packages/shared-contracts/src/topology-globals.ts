// expect-count: 3
// Direct member import from `effect/Schema`, plus `declare const` typed as opaque JSON.
import { decodeUnknownEffect, Json, Record as SchemaRecord, String as SchemaString } from 'effect/Schema';
import * as Schema from 'effect/Schema';

declare const REFERENCE_TOPOLOGY: Schema.Schema.Type<typeof Json>;

const OwnershipDocument = SchemaRecord(SchemaString, Json);

export const readOwnership = () => decodeUnknownEffect(OwnershipDocument)(REFERENCE_TOPOLOGY);
