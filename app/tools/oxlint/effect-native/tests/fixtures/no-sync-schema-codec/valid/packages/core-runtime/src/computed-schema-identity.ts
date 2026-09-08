import * as Effect from 'effect';
import { Schema } from 'effect';

Schema[`decodeUnknownEffect`];
Schema[('encodeResult' as const)];
const TemplateSchema = Effect[`Schema`];
TemplateSchema.validateEffect;
let MutableSchema = Effect[('Schema' as const)];
MutableSchema.decodeSync;
const local = { decodeSync: () => undefined };
local[`decodeSync`];
declare const key: string;
Schema[key];
Schema[`decode${key}Sync`];
