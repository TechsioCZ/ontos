// A no-substitution template literal is the same computed member as `Schema["decodeUnknownSync"]`,
// which the rule already reports.
import { Schema } from 'effect';

const ManifestSchema = Schema.Struct({ name: Schema.String });

export const decodeManifest = (value: unknown): { readonly name: string } =>
	Schema[`decodeUnknownSync`](ManifestSchema)(value);
