import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';

import { provesDataFactoryImport } from '../../anti-slop/effect/rules/data-factory-proof.ts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const factorySource = './factory.ts';
const effectImport = 'import { Effect } from "effect";';
const consumerSource = "import { makeData } from './factory.ts'; void makeData;";
const consumerFilename = 'consumer.ts';
const factoryFilename = 'factory.ts';
const nativeIndexColumn = 'columns.title.op("gin_trgm_ops")';
it('resolves native named schema, Result and Option imports without admitting executable or fake SDK values', () => {
  withTemporaryWorkspace((directory) => {
    const consumer = path.join(directory, consumerFilename);
    const factory = path.join(directory, factoryFilename);
    writeFileSync(consumer, consumerSource);
    writeFileSync(
      path.join(directory, 'fake-schema.ts'),
      [
        effectImport,
        'export const String = "data";',
        'export const Struct = () => Effect.succeed({});',
        'export const OptionFromNullOr = () => Effect.succeed(null);',
        'export const decodeUnknownResult = () => () => Effect.succeed({});',
      ].join('\n'),
    );
    const parseDeclaration = 'const parse = decode(Input);';
    const returnData = 'return { id: result.id, note: unwrapOption(result.note) };';
    const declaration = [
      effectImport,
      'import type { Schema } from "effect/Schema";',
      'import { String as Text, Struct, OptionFromNullOr, decodeUnknownResult as decode } from "effect/Schema";',
      'import { getOrThrow as unwrapResult } from "effect/Result";',
      'import { getOrNull as unwrapOption } from "effect/Option";',
      'const Input = Struct({ id: Text, note: OptionFromNullOr(Text) });',
      'type Input = Schema.Type<typeof Input>;',
      parseDeclaration,
      'export const makeData = (input: { readonly id: string; readonly note: string | null }) => {',
      '  const result: Input = unwrapResult(parse(input));',
      `  ${returnData}`,
      '};',
    ].join('\n');
    writeFileSync(factory, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    for (const source of [
      declaration.replace(returnData, 'return Effect.succeed(result);'),
      declaration.replace(returnData, 'return { id: result.id, run: () => fetch(result.id) };'),
      declaration.replace(parseDeclaration, `${parseDeclaration} fetch("eager-dependency");`),
      declaration.replaceAll('"effect/Schema"', '"./fake-schema.ts"'),
    ]) {
      writeFileSync(factory, source);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), source).toBe(false);
    }
  });
});

it('preserves recursive closed-data proof through the native Predicate submodule and rejects Effect or callback descendants', () => {
  withTemporaryWorkspace((directory) => {
    const consumer = path.join(directory, consumerFilename);
    const factory = path.join(directory, factoryFilename);
    writeFileSync(consumer, consumerSource);
    const declaration = [
      effectImport,
      'import { isObjectKeyword as isObject } from "effect/Predicate";',
      'const freeze = <Value>(value: Value): Value => {',
      '  if (!isObject(value) || value === null) return value;',
      '  for (const nested of Object.values(value)) freeze(nested);',
      '  return Object.freeze(value);',
      '};',
      'export const makeData = () => freeze([{ entries: [{ id: "closed" }] }]);',
    ].join('\n');
    writeFileSync(factory, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    for (const source of [
      declaration.replace('freeze(nested);', 'Effect.sync(() => fetch("runtime"));'),
      declaration.replace('{ id: "closed" }', '{ run: () => fetch("runtime") }'),
      declaration.replace('"effect/Predicate"', '"./unproved-predicate.ts"'),
    ]) {
      writeFileSync(factory, source);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), source).toBe(false);
    }
  });
});

it('proves native index access methods and operator classes without admitting executable index inputs', () => {
  withTemporaryWorkspace((directory) => {
    const consumer = path.join(directory, consumerFilename);
    const factory = path.join(directory, factoryFilename);
    writeFileSync(consumer, consumerSource);
    const declaration = [
      'import { sql } from "drizzle-orm";',
      'import { pgTable, text, index } from "drizzle-orm/pg-core";',
      'const table = pgTable("items", { title: text("title") }, (columns) => [',
      '  index("items_search").using("gin", columns.title.op("gin_trgm_ops")).where(sql`true`),',
      ']);',
      'export const makeData = () => ({ table });',
    ].join('\n');
    writeFileSync(factory, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    for (const source of [
      declaration.replace('"gin", columns.title.op', 'fetch("gin"), columns.title.op'),
      declaration.replace('"gin_trgm_ops"', 'fetch("operator")'),
      declaration.replace('"gin_trgm_ops"', '() => fetch("operator")'),
      declaration.replace(nativeIndexColumn, `sql\`\${fetch("index")}\``),
      declaration.replace(nativeIndexColumn, '{ op: () => fetch("index") }'),
      declaration.replace(nativeIndexColumn, 'columns.title.execute()'),
      declaration.replace('.where(sql`true`)', '.execute()'),
      declaration.replace('from "drizzle-orm/pg-core"', 'from "./fake-drizzle.ts"'),
    ]) {
      writeFileSync(factory, source);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), source).toBe(false);
    }
  });
});
