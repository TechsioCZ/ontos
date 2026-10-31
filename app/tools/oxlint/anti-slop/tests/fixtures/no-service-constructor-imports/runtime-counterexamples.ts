// Runtime witnesses for the analyzer's intentionally unsafe property-access inputs.
// These retain the native hidden/inherited method references and prototype behavior.
import { Schema, pipe } from 'effect';
import { expect } from 'effect-rstest';

interface OpaqueReplacement {
  readonly replace: (search: string, replacement: string) => unknown;
}
const hasReplacement = (value: unknown): value is OpaqueReplacement =>
  value !== null && typeof value === 'object' && 'replace' in value && typeof value.replace === 'function';

export const replaceOpaqueDecodedValue = (value: unknown) => {
  const replacement = hasReplacement(value) ? value : undefined;
  expect(replacement, 'the fixture decoder must retain the hidden replacement method').toBeDefined();
  return replacement?.replace('old', 'new');
};

const dictionaryFixtureCodec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String }));
const localDictionaryItem = (input: typeof dictionaryFixtureCodec.Type) => {
  const { item } = input;
  return item;
};
const parameterDictionaryItem = ({ item }: typeof dictionaryFixtureCodec.Type) => item;

export const proveDictionaryElementOpenness = (fixtureExecutable: () => string) => {
  const value = { item: { id: 'data', run: fixtureExecutable } };
  expect(localDictionaryItem(value)).toBe(value.item);
  expect(parameterDictionaryItem(value)).toBe(value.item);
  expect(value.item.run()).toBe('executable');
  let inheritedReads = 0;
  class InheritedDictionaryFixture {
    readonly [key: string]: { readonly id: string };
    get item() {
      inheritedReads += 1;
      return value.item;
    }
  }
  const inherited = new InheritedDictionaryFixture();
  expect(localDictionaryItem(inherited)).toBe(value.item);
  expect(parameterDictionaryItem(inherited)).toBe(value.item);
  expect(inheritedReads).toBe(2);
};

export const proveInheritedPropertyLookups = () => {
  const decode = Schema.decodeUnknownSync(Schema.Json);
  let calls = 0;
  const replacement = Object.defineProperty({ id: 'data' }, 'replace', {
    value: () => {
      calls += 1;
      return 'executed';
    },
  });
  const execute = (value: { readonly id: string }) => replaceOpaqueDecodedValue(decode(value));
  const decodeDictionary = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Literal('safe')));
  expect(decodeDictionary({}).label).toBeUndefined();
  expect(decodeDictionary({ label: 'safe' }).label).toBe('safe');
  expect(decodeDictionary({ toString: 'safe' }).toString).toBe('safe');
  expect(decodeDictionary({ constructor: 'safe' }).constructor).toBe('safe');
  expect(Object.getPrototypeOf(decodeDictionary({ __proto__: null }))).toBe(Object.prototype);
  const match = /(?<name>safe)/u.exec('safe');
  expect(match?.groups).toBeDefined();
  expect(Object.getPrototypeOf(match?.groups ?? {})).toBeNull();
  const absentToString = pipe(undefined, Schema.decodeUnknownSync(Schema.Undefined));
  const variants = [
    (value: { readonly id: string }) => {
      const dict = decodeDictionary({});
      return Object.is(dict.toString, 'safe') ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const dict = decodeDictionary({});
      const { constructor: inheritedConstructor = 'safe' } = dict;
      return Object.is(inheritedConstructor, 'safe') ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const dict = decodeDictionary({});
      const selected = replacement.id === 'data' ? dict : { constructor: 'safe' };
      return selected.constructor === 'safe' ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const dict = decodeDictionary({});
      return dict.label === 'safe' ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const empty = {};
      return empty.toString === undefined ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const { toString: inheritedToString } = {};
      return inheritedToString === undefined ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const selected: { readonly toString?: unknown } = replacement.id === 'data' ? {} : { toString: absentToString };
      return selected.toString === undefined ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const selected = {};
      return selected.toString === undefined ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const branch: { readonly toString?: unknown } = replacement.id === 'data' ? {} : { toString: absentToString };
      const selected = { ...branch };
      const { toString: inheritedToString } = selected;
      return inheritedToString === undefined ? 'safe' : execute(value);
    },
  ];
  expect(variants.map((makeData) => makeData(replacement))).toEqual(variants.map(() => 'executed'));
  expect(calls).toBe(variants.length);
  expect({}.constructor).toBe(Object);
  expect({ __proto__: Object.prototype }.__proto__).toBe(Object.prototype);
  let getterCalls = 0;
  class InheritedExtraFixture {
    readonly id = 'prototype';

    get extra() {
      getterCalls += 1;
      return 'inherited';
    }
  }
  const inherited = new InheritedExtraFixture();
  expect(inherited.extra === undefined ? 'safe' : execute(replacement)).toBe('executed');
  expect(getterCalls).toBe(1);
  expect(calls).toBe(variants.length + 1);
};
