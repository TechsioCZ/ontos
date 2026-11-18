import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  defineRead,
  getReadAccessQuestions,
  getReadCalls,
  getReadHandler,
  getReadRun,
} from '../../src/reads/definition.ts';
import type { ReadLoadContext } from '../../src/reads/definition.ts';
import { declaredCall, declaredWriteCall, moduleOperation } from '../../src/sdk/index.ts';
import { canList, canRun, readAnswer } from '../../src/sdk/read.ts';
import type { DefineReadSdkForms, ReadRunContext } from '../../src/sdk/read.ts';

/**
 * `defineRead` takes three spellings: the bare handler and `{ load }` (one transaction, as before) and
 * `{ run }` (the kernel form). What the types cannot state is refused at definition.
 */

const MODULE = 'test.sdk-forms';

const descriptor = (readKey: string) => ({
  accessDeclaration: {
    key: `${readKey}.read`,
    kind: 'read' as const,
    modes: ['run' as const],
    placement: { group: 'inventory', level: 'basic' as const },
    risk: 'routine' as const,
    selectors: [],
  },
  accessKind: 'detail' as const,
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: readKey,
    moduleKey: MODULE,
    role: 'api',
  }),
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: `${readKey}.evidence` },
  inputSchema: Schema.Struct({ subject: Schema.String }),
  legalEntityScope: 'forbidden' as const,
  owningModuleKey: MODULE,
  policies: [],
  readKey,
  resultSchema: Schema.Struct({ outcome: Schema.String }),
  schemaVersion: '1',
});

const restrictions = moduleOperation({
  kind: 'read',
  path: '/restrictions',
  provider: { entrypointKey: 'test.provider.api.restrictions', moduleId: 'test.provider', schemaVersion: '1' },
  request: Schema.Struct({ subject: Schema.String }),
  response: Schema.Struct({ outcome: Schema.String }),
});
const reserve = moduleOperation({
  kind: 'write',
  path: '/reserve',
  provider: { entrypointKey: 'test.provider.api.reserve', moduleId: 'test.provider', schemaVersion: '1' },
  request: Schema.Struct({ subject: Schema.String }),
  response: Schema.Struct({ outcome: Schema.String }),
});
const calls = { restrictions: declaredCall(restrictions, `${MODULE}.requirement.restrictions`) } as const;

const services = () => Effect.succeed({ label: 'owner' });
const handler = (input: { readonly subject: string }, context: ReadLoadContext<{ readonly label: string }>) =>
  Effect.succeed(readAnswer({ outcome: `${input.subject}:${context.services.label}` }, { resultCount: 1 }));
const run = (
  input: { readonly subject: string },
  context: ReadRunContext<{ readonly label: string }, typeof calls, Readonly<Record<never, never>>>,
) =>
  context
    .call('restrictions', { subject: input.subject })
    .pipe(Effect.map((answer) => readAnswer({ outcome: answer._tag }, { resultCount: 1 })));

/** The neighbouring registration access questions ask about. */
const recordsRead = defineRead(descriptor(`${MODULE}.records`), handler, services);

it('defineRead satisfies the two SDK signatures next to its existing one', () => {
  const sdkForms: DefineReadSdkForms = defineRead;
  expect(sdkForms).toBe(defineRead);
});

it('defines a { run } read with its calls kept in the registration, not in the descriptor', () => {
  const registration = defineRead({ ...descriptor(`${MODULE}.run`), calls }, { run }, services);
  expect(getReadRun(registration)).toBe(run);
  expect(getReadCalls(registration)).toEqual(calls);
  expect(Object.isFrozen(getReadCalls(registration))).toBe(true);
  expect(getReadAccessQuestions(registration)).toEqual([]);
  expect(Object.keys(registration.descriptor)).not.toContain('calls');
  expect(Object.keys(registration.descriptor)).not.toContain('accessQuestions');
  // The kernel form has no one-transaction handler to hand out.
  expect(() => getReadHandler(registration)).toThrow(/is defined with \{ run \}/u);
});

it('keeps the bare handler and { load } exactly as before: no run, no calls, no questions', () => {
  const unchanged = descriptor(`${MODULE}.unchanged`);
  const bare = defineRead(unchanged, handler, services);
  const load = defineRead(unchanged, { load: handler }, services);
  for (const registration of [bare, load]) {
    expect(getReadHandler(registration)).toBe(handler);
    expect(getReadRun(registration)).toBeUndefined();
    expect(getReadCalls(registration)).toEqual({});
    expect(getReadAccessQuestions(registration)).toEqual([]);
  }
  expect(load.descriptor).toEqual(bare.descriptor);
});

it('materializes the access questions of a { load } read once, at definition', () => {
  const registration = defineRead(
    {
      ...descriptor(`${MODULE}.questions`),
      accessQuestions: { rows: canList(recordsRead), write: canRun(recordsRead) },
    },
    {
      load: (input, context) =>
        Effect.succeed(readAnswer({ outcome: `${input.subject}:${context.access.write}` }, { resultCount: 1 })),
    },
    services,
  );
  expect(getReadAccessQuestions(registration).map(({ kind, name }) => ({ kind, name }))).toEqual(
    expect.arrayContaining([
      { kind: 'list', name: 'rows' },
      { kind: 'decide', name: 'write' },
    ]),
  );
});

/** Values the types admit (they are no fresh literals) that only the definition-time check refuses. */
const runAndLoad = { load: handler, run };
const runWithExtra = { extra: true, run };
const runWithGetter = {
  get run() {
    return run;
  },
};

it('refuses { run, load }, { run } with any other key, and a { run } that is no data property', () => {
  expect(() => defineRead({ ...descriptor(`${MODULE}.both`), calls }, runAndLoad, services)).toThrow(
    /\{ run \} and \{ load \} are two forms of a read/u,
  );
  expect(() => defineRead({ ...descriptor(`${MODULE}.extra`), calls }, runWithExtra, services)).toThrow(
    /\{ run \} must hold the run function as its only own enumerable data property/u,
  );
  expect(() => defineRead({ ...descriptor(`${MODULE}.getter`), calls }, runWithGetter, services)).toThrow(
    /\{ run \} must hold the run function as its only own enumerable data property/u,
  );
});

it('refuses calls on a bare or { load } read and access questions on a bare handler', () => {
  expect(() => defineRead({ ...descriptor(`${MODULE}.bare-calls`), calls }, handler, services)).toThrow(
    /only the \{ run \} form declares calls/u,
  );
  expect(() => defineRead({ ...descriptor(`${MODULE}.load-calls`), calls }, { load: handler }, services)).toThrow(
    /only the \{ run \} form declares calls/u,
  );
  expect(() =>
    defineRead(
      { ...descriptor(`${MODULE}.bare-questions`), accessQuestions: { write: canRun(recordsRead) } },
      handler,
      services,
    ),
  ).toThrow(/accessQuestions need the \{ load \} or \{ run \} form/u);
});

it('refuses access questions on a read the access gate does not decide', () => {
  const { accessDeclaration: _scopeWide, ...legacyBase } = descriptor(`${MODULE}.legacy`);
  const legacy = {
    ...legacyBase,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: `${MODULE}.legacy`,
      moduleKey: MODULE,
      role: 'api',
    }),
    legalEntityScope: 'optional' as const,
    permissionTarget: 'module' as const,
  };
  expect(() =>
    defineRead({ ...legacy, accessQuestions: { write: canRun(recordsRead) } }, { load: handler }, services, () => ({
      kind: 'module',
      moduleId: MODULE,
    })),
  ).toThrow(/the read must be protected/u);
});

it('refuses a write call in any read', () => {
  // A write call carries its recovery; the types already refuse it, the definition refuses it at runtime.
  const writeCalls = {
    reserve: declaredWriteCall(reserve, `${MODULE}.requirement.reserve`, 'restrictions'),
    restrictions: calls.restrictions,
  };
  const disguised = { ...calls.restrictions, operation: { ...restrictions } };
  Reflect.set(disguised.operation, 'kind', 'write');
  expect(() =>
    defineRead({ ...descriptor(`${MODULE}.write`), calls: { restrictions: disguised } }, { run }, services),
  ).toThrow(/is a write call; a read declares only read calls/u);
  const withRecovery = { ...descriptor(`${MODULE}.recovery`) };
  Reflect.set(withRecovery, 'calls', writeCalls);
  expect(() => defineRead(withRecovery, { run }, services)).toThrow(/reserve is a write call/u);
});

it('refuses a legacy result permission resolver on a { run } read', () => {
  expect(() =>
    defineRead({ ...descriptor(`${MODULE}.result-filter`), calls }, { run }, services, undefined, () => []),
  ).toThrow(/a \{ run \} read declares no legacy result permission resolver/u);
});
