// `.spec.tsx` under `tests/`: proving rejection with a throwing decoder is the D-tier blessed shape.
import assert from 'node:assert/strict';
import { Schema } from 'effect';

const RowSchema = Schema.Struct({ id: Schema.String });

assert.throws(() => Schema.decodeUnknownSync(RowSchema)({}));

export const Row = ({ raw }: { readonly raw: unknown }): JSX.Element => (
	<span>{Schema.decodeUnknownSync(RowSchema)(raw).id}</span>
);
