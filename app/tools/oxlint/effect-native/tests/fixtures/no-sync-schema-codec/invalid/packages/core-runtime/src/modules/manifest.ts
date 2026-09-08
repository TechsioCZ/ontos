// expect-count: 3
// Submodule namespace import, computed access and optional chaining are all the same call.
import * as Schema from 'effect/Schema';

const ManifestSchema = Schema.Struct({ name: Schema.String });

export const decodeManifest = (value: unknown): { readonly name: string } =>
	Schema.decodeUnknownSync(ManifestSchema, { onExcessProperty: 'error' })(value);

export const encodeManifest = (value: { readonly name: string }): unknown =>
	Schema['encodeUnknownSync'](ManifestSchema)(value);

export const validateManifest = (value: unknown): unknown => Schema?.validateSync(ManifestSchema)(value);
