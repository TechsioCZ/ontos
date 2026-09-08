// Re-binding the namespace locally (destructuring, or a plain `const` alias) is the same
// reference to the same throwing entry point, just written differently.
import { Schema } from 'effect';

const EntrypointSchema = Schema.Struct({ id: Schema.String });

const { decodeUnknownSync, encodeSync } = Schema;

const Codec = Schema;

export const decodeEntrypoint = (value: unknown): { readonly id: string } =>
	decodeUnknownSync(EntrypointSchema)(value);

export const encodeEntrypoint = (value: { readonly id: string }): unknown => encodeSync(EntrypointSchema)(value);

export const validateEntrypoint = (value: unknown): unknown => Codec.validateSync(EntrypointSchema)(value);
