// Specifiers that merely look like Effect: a package whose name starts with "effect", a relative
// path ending in `effect/Schema`, a non-`effect-*` Modern.js entry, and `effect/SchemaAST`.
import { Schema as CompatSchema } from 'effect-schema-compat';
import { Schema as LocalSchema } from './effect/Schema.ts';
import { Schema as BffSchema } from '@modern-js/plugin-bff/react';
import * as SchemaAST from 'effect/SchemaAST';

export const compat = CompatSchema.decodeUnknownSync('raw');
export const local = LocalSchema.encodeSync('raw');
export const bff = BffSchema.validateSync('raw');
export const ast = SchemaAST.decodeUnknownSync('raw');
