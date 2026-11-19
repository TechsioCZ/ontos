import { loadPluginRules, ruleTester, virtualFile } from './rule-tester.mts';
import type { InvalidCase, ValidCase } from './rule-tester.mts';

/**
 * Regression cases for the lexical type-alias resolution shared by the anti-slop `object` and
 * `unknown` contract rules: block and forward aliases, generic arguments and defaults, cycles, and
 * every binder that shadows a module alias (type parameters, mapped keys, `infer`, interfaces,
 * classes and imports). Cases run through Oxlint's own parser and rule runtime.
 */
const antiSlopRules = await loadPluginRules('../../anti-slop/index.ts');
const filename = virtualFile('anti-slop/alias-resolution.ts');

type InvalidEntry = readonly [code: string, errors: InvalidCase['errors']];

const register = (
  name: string,
  cases: { readonly invalid: readonly InvalidEntry[]; readonly valid: readonly string[] },
): void => {
  const rule = antiSlopRules[name];
  if (rule === undefined) {
    throw new Error(`anti-slop does not register ${name}`);
  }
  ruleTester.run(`anti-slop/${name} alias resolution`, rule, {
    invalid: cases.invalid.map(([code, errors]): InvalidCase => ({ code, errors, filename })),
    valid: cases.valid.map((code): ValidCase => ({ code, filename })),
  });
};

const unknownAlias = (alias: string) => ({ data: { alias }, messageId: 'unknownAlias' });
const unknownReturn = { messageId: 'unknownReturn' };
const objectParameter = (parameter: string) => ({ data: { parameter }, messageId: 'objectParameter' });

register('no-unknown-type-aliases', {
  invalid: [
    [
      "import * as Hidden from './value.js'; type Hidden = unknown; type Linked = Hidden;",
      [unknownAlias('Hidden'), unknownAlias('Linked')],
    ],
    [
      "type Hidden = unknown; import * as Hidden from './value.js'; type Linked = Hidden;",
      [unknownAlias('Hidden'), unknownAlias('Linked')],
    ],
    [
      "import Hidden from './value.js'; type Hidden = unknown; type Linked = Hidden;",
      [unknownAlias('Hidden'), unknownAlias('Linked')],
    ],
    [
      "type Hidden = unknown; import Hidden from './value.js'; type Linked = Hidden;",
      [unknownAlias('Hidden'), unknownAlias('Linked')],
    ],
    ['function read() { type Hidden = unknown; return 1; }', [unknownAlias('Hidden')]],
    [
      'function read() { type Hidden = Later; type Later = unknown; return 1; }',
      [unknownAlias('Hidden'), unknownAlias('Later')],
    ],
    ['type Box<T> = T; type Hidden = Box<unknown>;', [unknownAlias('Hidden')]],
    ['type Box<T> = T; type Hidden = Box<Box<unknown>>;', [unknownAlias('Hidden')]],
    ['type Box<T = unknown> = T; type Hidden = Box;', [unknownAlias('Hidden')]],
    ['type Pair<T, U = T> = U; type Hidden = Pair<unknown>;', [unknownAlias('Hidden')]],
    ['type Value = unknown; type Generic<Value> = Value;', [unknownAlias('Value')]],
  ],
  valid: [
    'type Result = unknown | ReturnType<typeof JSON.parse>;',
    'type Result = string | unknown;',
    'type Envelope = { readonly payload: unknown };',
    'type Guard = (value: unknown) => value is string;',
    'type Box<T> = T;',
    'type Box<T = unknown> = T;',
    'type First = Second; type Second = First;',
    'type Json = string | readonly Json[] | { readonly [key: string]: Json };',
    'type Looping<T = T> = T; type Uses = Looping;',
  ],
});

register('no-unknown-returns', {
  invalid: [
    ["import * as Result from './value.js'; type Result = unknown; declare function read(): Result;", [unknownReturn]],
    ["type Result = unknown; import * as Result from './value.js'; declare function read(): Result;", [unknownReturn]],
    ["import Result from './value.js'; type Result = unknown; declare function read(): Result;", [unknownReturn]],
    ["type Result = unknown; import Result from './value.js'; declare function read(): Result;", [unknownReturn]],
    ['type Value = unknown; declare function read(): Promise<Value>;', [unknownReturn]],
    ['type Wrap<T> = Promise<T>; declare function read(): Wrap<unknown>;', [unknownReturn]],
    ['type Box<T> = T; declare function read(): Box<Box<unknown>>;', [unknownReturn]],
    ['type Payload<T = unknown> = PromiseLike<T>; declare function read(): Payload;', [unknownReturn]],
    ['function outer() { const read = (): Result => 1; type Result = unknown; return read; }', [unknownReturn]],
    ['type Promise<T> = T; declare function read(): Promise<unknown>;', [unknownReturn]],
  ],
  valid: [
    "import * as Result from './value.js'; declare function read(): Result;",
    "import Result from './value.js'; declare function read(): Result;",
    'function isText(value: unknown): value is string { return value === "text"; }',
    'type Envelope = { readonly payload: unknown }; declare function read(): Envelope;',
    'type Value = unknown; declare function read<Value>(): Value;',
    'type First = Second; type Second = First; declare function read(): First;',
    'type Box<T> = T; declare function read<T>(): Box<T>;',
    'class Promise<T> { value?: T } declare function read(): Promise<unknown>;',
    "import { Promise } from 'bluebird'; declare function read(): Promise<unknown>;",
    'declare function read<Promise>(): Promise<unknown>;',
    'type Result = unknown; function outer() { interface Result { readonly id: string } return (): Result => ({ id: "a" }); }',
    'type T = string; type Inner = T; type Outer<T> = Inner; declare function read(): Outer<unknown>;',
  ],
});

register('no-object-parameters', {
  invalid: [
    [
      "import * as Input from './value.js'; type Input = object; function take(value: Input) { return [Input, value]; }",
      [objectParameter('value')],
    ],
    [
      "type Input = object; import * as Input from './value.js'; function take(value: Input) { return [Input, value]; }",
      [objectParameter('value')],
    ],
    [
      "import Input from './value.js'; type Input = object; function take(value: Input) { return [Input(), value]; }",
      [objectParameter('value')],
    ],
    [
      "type Input = object; import Input from './value.js'; function take(value: Input) { return [Input(), value]; }",
      [objectParameter('value')],
    ],
    [
      'type Input = object; switch ((value: Input) => value) { default: type Input = { id: string }; }',
      [objectParameter('value')],
    ],
    [
      "import { parse as Input } from 'node:path'; type Input = object; function take(value: Input) { return [Input('a'), value]; }",
      [objectParameter('value')],
    ],
    [
      "type Input = object; import { parse as Input } from 'node:path'; function take(value: Input) { return [Input('a'), value]; }",
      [objectParameter('value')],
    ],
    ['type Input<T> = T; declare function take(value: Input<object>): void;', [objectParameter('value')]],
    ['function outer() { return (value: Input) => value; type Input = object; }', [objectParameter('value')]],
    ['type Input = object; function take({ id }: Input) { return id; }', [objectParameter('{ id }')]],
    [
      'type Input = object; const Holder = class Input {}; declare function take(value: Input): void;',
      [objectParameter('value')],
    ],
    [
      'type Value = object; type Handler<T> = T extends (T extends Box<infer Value> ? 1 : 2) ? (value: Value) => void : never; type Box<T> = { box: T };',
      [objectParameter('value')],
    ],
  ],
  valid: [
    "import * as Input from './value.js'; function take(value: Input) { return value; }",
    "import Input from './value.js'; function take(value: Input) { return value; }",
    'type Input = object; switch (1) { default: type Input = { id: string }; const take = (value: Input) => value; }',
    "import { parse as Input } from 'node:path'; function take(value: Input) { return value; }",
    'type Input = object; declare function take<Input>(value: Input): void;',
    'type Input = object; function outer() { interface Input { readonly id: string } return (value: Input) => value; }',
    'type Input = object; const Holder = class Input { take(value: Input) { return value; } };',
    'type Key = object; type Handlers = { [Key in "a" | "b"]: (value: Key) => void };',
    'type Value = object; type Handler<T> = T extends Box<infer Value> ? (value: Value) => void : never; type Box<T> = { box: T };',
    'type First = Second; type Second = First; declare function take(value: First): void;',
  ],
});
