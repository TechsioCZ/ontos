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
import { ModuleOperationRouteSchema, declaredCall, declaredWriteCall, moduleOperation } from '../../src/sdk/index.ts';
import type { CallCapability, RecoveriesDeclared } from '../../src/sdk/index.ts';
import { canList, canRun, readAnswer } from '../../src/sdk/read.ts';
import type { ReadRunContext } from '../../src/sdk/read.ts';

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

it('reads each step of the definition once and registers the value it validated', () => {
  const reads = { load: 0, run: 0 };
  const laterHandler: typeof handler = (input, context) => handler(input, context);
  const laterRun: typeof run = (input, context) => run(input, context);
  const loadRegistration = defineRead(
    descriptor(`${MODULE}.load-once`),
    {
      get load() {
        reads.load += 1;
        return reads.load === 1 ? handler : laterHandler;
      },
    },
    services,
  );
  const runRegistration = defineRead(
    { ...descriptor(`${MODULE}.run-once`), calls },
    {
      get run() {
        reads.run += 1;
        return reads.run === 1 ? run : laterRun;
      },
    },
    services,
  );
  expect(reads).toEqual({ load: 1, run: 1 });
  expect(getReadHandler(loadRegistration)).toBe(handler);
  expect(getReadRun(runRegistration)).toBe(run);
});

/** Values the types admit (they are no fresh literals) that only the definition-time check refuses. */
const runAndLoad = { load: handler, run };
const runWithExtra = { extra: true, run };

it('refuses { run, load } and { run } with any other key', () => {
  expect(() => defineRead({ ...descriptor(`${MODULE}.both`), calls }, runAndLoad, services)).toThrow(
    /\{ run \} and \{ load \} are two forms of a read/u,
  );
  expect(() => defineRead({ ...descriptor(`${MODULE}.extra`), calls }, runWithExtra, services)).toThrow(
    /unknown key extra/u,
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

it('registers a frozen snapshot of each declared operation, its route and provider with it', () => {
  const route = { _tag: 'Module' as const, path: '/restrictions' as const };
  const provider = { ...restrictions.provider };
  const operation = { ...restrictions, provider, route };
  const registration = defineRead(
    {
      ...descriptor(`${MODULE}.snapshot`),
      calls: { restrictions: declaredCall(operation, `${MODULE}.requirement.restrictions`) },
    },
    { run },
    services,
  );
  Reflect.set(route, 'path', '/elsewhere');
  Reflect.set(provider, 'entrypointKey', 'test.provider.api.elsewhere');
  const registered = getReadCalls(registration)['restrictions']?.operation;
  const registeredRoute = registered?.route;
  expect(Schema.is(ModuleOperationRouteSchema)(registeredRoute) ? registeredRoute.path : undefined).toBe(
    '/restrictions',
  );
  expect(registered?.provider.entrypointKey).toBe('test.provider.api.restrictions');
  expect(
    Object.isFrozen(registered) && Object.isFrozen(registered?.route) && Object.isFrozen(registered?.provider),
  ).toBe(true);
  // The schemas are the reference's own.
  expect(registered?.request).toBe(restrictions.request);
});

/** Type-level checks of the SDK surface; the function is never run. */
const surfaceTypes = (call: CallCapability<typeof twoCalls>, subject: 'other' | 'restrictions') => {
  const loadWithoutQuestions = defineRead(
    descriptor(`${MODULE}.load-without-questions`),
    {
      load: (input, context) => {
        // @ts-expect-error A { load } read that asks nothing may receive no context.access.
        const answers: object = context.access;
        return Effect.succeed(
          readAnswer({ outcome: `${input.subject}:${Object.keys(answers).length}` }, { resultCount: 1 }),
        );
      },
    },
    services,
  );
  const writeWithoutRecovery = {
    reserve: { operation: reserve, requirementKey: `${MODULE}.requirement.reserve` },
    restrictions: calls.restrictions,
  };
  const readWithRecovery = { restrictions: { ...calls.restrictions, recovery: 'restrictions' as const } };
  const writeWithRecovery = {
    reserve: declaredWriteCall(reserve, `${MODULE}.requirement.reserve`, 'restrictions'),
    restrictions: calls.restrictions,
  };
  // @ts-expect-error A write call must name its recovery.
  const missingRecovery: RecoveriesDeclared<typeof writeWithoutRecovery> = writeWithoutRecovery;
  // @ts-expect-error A read call names no recovery.
  const readRecovery: RecoveriesDeclared<typeof readWithRecovery> = readWithRecovery;
  const declaredRecovery: RecoveriesDeclared<typeof writeWithRecovery> = writeWithRecovery;
  return [
    loadWithoutQuestions,
    missingRecovery,
    readRecovery,
    declaredRecovery,
    call('restrictions', { subject: 'a' }),
    call('other', { count: 1 }),
    // @ts-expect-error A name typed as a union takes only arguments every member accepts.
    call(subject, { subject: 'a' }),
  ];
};
const twoCalls = {
  other: declaredCall(
    moduleOperation({
      kind: 'read',
      path: '/other',
      provider: { entrypointKey: 'test.provider.api.other', moduleId: 'test.provider', schemaVersion: '1' },
      request: Schema.Struct({ count: Schema.Finite }),
      response: Schema.Struct({ outcome: Schema.String }),
    }),
    `${MODULE}.requirement.other`,
  ),
  restrictions: calls.restrictions,
} as const;

it('states the SDK surface rules in its types', () => {
  expect(surfaceTypes).toBeTypeOf('function');
});
