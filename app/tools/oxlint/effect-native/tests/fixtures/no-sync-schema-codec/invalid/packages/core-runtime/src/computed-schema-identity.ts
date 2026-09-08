// expect-count: 6
import * as Effect from 'effect';
import { Schema } from 'effect';

Schema[`decodeUnknownSync`];
Schema[('encodeSync' as const)];
Effect[`Schema`].validateSync;
Effect[('Schema' as const)].decodeSync;
const TemplateSchema = Effect[`Schema`];
const WrappedSchema = Effect[('Schema' as const)];
TemplateSchema.decodeUnknownSync;
WrappedSchema.encodeUnknownSync;
