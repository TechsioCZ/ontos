// expect-count: 1
// `.cts` module: the rule documents `.cts` coverage.
import { Schema } from 'effect';

const RegistrySchema = Schema.Struct({ id: Schema.String });

export const decodeRegistry = (value: unknown): { readonly id: string } =>
	Schema.decodeUnknownSync(RegistrySchema)(value);
