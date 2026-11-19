import { NodeCrypto } from '@effect/platform-node';
import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import type { CallRoute, RouteAnswer } from '../../src/execution/contract.ts';
import { validateActiveApplicationCompositionSnapshot } from '../../src/modules/active-application-composition.ts';
import {
  ONTOS_SHELL_CONTRIBUTION_ABI,
  OntosShellRuntimeContractSchema,
} from '../../src/modules/application-composition.ts';
import { defineOntosModuleManifest, OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { OntosModuleRequirementsSchema } from '../../src/modules/module-dependency-contracts.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import type { ReadHandlerResult } from '../../src/reads/context.ts';
import type { AnyReadRegistration, ReadLoadContext } from '../../src/reads/definition.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { ReadHandlerUnavailable, ReadPermissionDenied } from '../../src/reads/errors.ts';
import { callAnswer, declaredCall, moduleOperation } from '../../src/sdk/index.ts';
import type { CallOutcome } from '../../src/sdk/index.ts';
import { canRun, readAnswer } from '../../src/sdk/read.ts';
import type { NoAccessQuestions, ReadRunContext } from '../../src/sdk/read.ts';
import type { TestAccessOutcome } from '../../src/testing/access-gate.ts';
import {
  makeModuleContractFixture,
  makePublishedApplicationCompositionSnapshotFixture,
} from '../../src/testing/module-contract.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';

/**
 * The SDK kernel end to end through Core's read test harness: a `{ run }` read executes on the real read
 * runtime, the real kernel sessions, transactions, requirement lookup, call executor and run evidence,
 * over the harness's scripted database, with a stub of the governed HTTP route to the provider module.
 * The one-transaction forms (`{ load }` and a bare handler) keep their own suites, untouched.
 */

const MODULE = 'test.sdk-kernel';
const READ_KEY = `${MODULE}.api.eligibility`;
const OTHER_KEY = `${MODULE}.api.records`;
const SECRET_GROUP_KEY = `${READ_KEY}.secret`;
const tenantId = '30000000-0000-4000-8000-000000000001';
const scope: OperationalScope = {
  authBindingId: '30000000-0000-4000-8000-000000000002',
  authContextRef: 'better-auth-session:sdk-kernel',
  authMethod: 'session',
  correlationId: 'sdk-kernel-end-to-end',
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
};
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-18T10:00:00.000Z'));

const ResultSchema = Schema.Struct({
  restriction: Schema.String,
  secret: Schema.optionalKey(Schema.String),
  state: Schema.Literals(['CURRENT', 'STALE', 'UNAVAILABLE']),
});
type Result = typeof ResultSchema.Type;

const entrypointOf = (entrypointKey: string) =>
  defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey,
    moduleKey: MODULE,
    role: 'api',
  });

const descriptor = (readKey: string = READ_KEY) => ({
  accessDeclaration: {
    key: `${readKey}.read`,
    kind: 'read' as const,
    modes: ['run' as const],
    placement: { group: 'inventory', level: 'basic' as const },
    risk: 'routine' as const,
    selectors: [],
  },
  accessFieldGroups: [
    {
      fieldClass: 'salaries' as const,
      fields: ['secret'],
      key: SECRET_GROUP_KEY,
      kind: 'field_read' as const,
      modes: ['run' as const],
      placement: { group: 'inventory', level: 'extended' as const },
      risk: 'sensitive' as const,
      selectors: [],
    },
  ],
  accessKind: 'detail' as const,
  entrypoint: entrypointOf(readKey),
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: `${readKey}.evidence` },
  inputSchema: Schema.Struct({ subject: Schema.String }),
  legalEntityScope: 'forbidden' as const,
  owningModuleKey: MODULE,
  policies: [],
  readKey,
  resultSchema: ResultSchema,
  schemaVersion: '1',
});

const restrictionsOperation = moduleOperation({
  kind: 'read',
  path: '/restrictions',
  provider: { entrypointKey: 'test.provider.api.restrictions', moduleId: 'test.provider', schemaVersion: '1' },
  request: Schema.Struct({ subject: Schema.String }),
  response: Schema.Struct({ restriction: Schema.String }),
});
const REQUIREMENT_KEY = `${MODULE}.requirement.restrictions`;
const calls = { restrictions: declaredCall(restrictionsOperation, REQUIREMENT_KEY) } as const;

interface Services {
  readonly load: (subject: string) => Effect.Effect<{ readonly secret: string; readonly state: 'CURRENT' }>;
}
const services = () =>
  Effect.succeed<Services>({ load: (subject) => Effect.succeed({ secret: `owner:${subject}`, state: 'CURRENT' }) });

type RunContext = ReadRunContext<Services, typeof calls, NoAccessQuestions>;
type Run = (
  input: { readonly subject: string },
  context: RunContext,
) => Effect.Effect<ReadHandlerResult<Result>, unknown>;

const runRead = (run: Run) => defineRead({ ...descriptor(), calls }, { run }, services);
const answered = (value: Result) => readAnswer(value, { resultCount: 1 });

/** The restriction a call outcome leaves the module, by its typed tag. */
const restrictionOf = (outcome: CallOutcome<{ readonly restriction: string }>): string =>
  Option.match(callAnswer(outcome), { onNone: () => outcome._tag, onSome: (value) => value.restriction });

const PROVIDER_MODULE = 'test.provider';
const consumerBase = makeModuleContractFixture({ appId: 'sdk-kernel-consumer', moduleId: MODULE });
const requirements = Schema.decodeUnknownSync(OntosModuleRequirementsSchema)({
  coreCapabilities: [],
  intrinsic: [],
  operations: [
    {
      callers: [{ kind: 'person', legalEntityScope: 'subject' }],
      condition: `${MODULE}.condition.restrictions`,
      entrypointKey: READ_KEY,
      evidence: [`${MODULE}.evidence.restrictions`],
      key: REQUIREMENT_KEY,
      provider: { ...restrictionsOperation.provider },
    },
  ],
  schemaVersion: '1',
});
const encodedRequirements = Schema.encodeSync(OntosModuleRequirementsSchema)(requirements);
const shellDeployment = { appId: 'shell-super-app', buildMarker: 'sdk-kernel-shell' } as const;
const shellRuntimeDocument = Schema.encodeSync(Schema.fromJsonString(OntosShellRuntimeContractSchema))({
  contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
  coreCapabilities: [],
  deployment: shellDeployment,
  schemaVersion: '2',
});
const hostOf = (reads: readonly AnyReadRegistration[]) =>
  defineVerticalRuntimeRegistration({
    actions: [],
    manifest: defineOntosModuleManifest({
      ...consumerBase.manifest,
      publicSurface: { ...consumerBase.manifest.publicSurface, actions: [], api: {}, components: {} },
      requirements,
    }),
    outboxWorkers: [],
    reads,
  });

/**
 * The active Application Composition the calling module and its provider are installed in: the
 * consumer's published requirement (with its callers) and the provider's published operation.
 */
const composition = Effect.gen(function* compositionOf() {
  const decodeContract = Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema);
  const consumer = yield* decodeContract({
    ...consumerBase,
    manifest: {
      ...consumerBase.manifest,
      requirements: encodedRequirements,
    },
  });
  const providerBase = makeModuleContractFixture({ appId: 'sdk-kernel-provider', moduleId: PROVIDER_MODULE });
  const provider = yield* decodeContract({
    ...providerBase,
    manifest: {
      ...providerBase.manifest,
      publicSurface: {
        ...providerBase.manifest.publicSurface,
        api: [{ key: `${PROVIDER_MODULE}.public`, operationKeys: ['restrictions'] }],
        operationContracts: [
          {
            apiKey: `${PROVIDER_MODULE}.public`,
            entrypoint: defineTenantModuleEntrypoint({
              access: 'read',
              authorization: { kind: 'authenticated_principal' },
              entrypointKey: restrictionsOperation.provider.entrypointKey,
              moduleKey: PROVIDER_MODULE,
              role: 'api',
            }),
            operationKey: 'restrictions',
            schemaVersion: restrictionsOperation.provider.schemaVersion,
          },
        ],
      },
    },
  });
  const snapshot = yield* makePublishedApplicationCompositionSnapshotFixture({
    contractInputs: [consumer, provider],
    publishedShellRuntime: { document: shellRuntimeDocument, receiverDeployment: shellDeployment },
    validityMs: 3_600_000,
  }).pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
  return { deployment: consumer.deployment, snapshot };
});

const routeAnswering = (answer: RouteAnswer): CallRoute => ({ send: () => Effect.succeed(answer) });
const restrictedAnswer: RouteAnswer = { _tag: 'Answered', encoded: { restriction: 'NONE' } };

const harnessFor = Effect.fn('SdkKernelEndToEnd.harness')(function* harnessFor(
  registration: AnyReadRegistration,
  options: {
    readonly access?: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>;
    readonly extraReads?: readonly AnyReadRegistration[];
    readonly route?: CallRoute;
  } = {},
) {
  const { deployment, snapshot } = yield* composition;
  const { revision } = snapshot.composition;
  const harness = yield* makeReadTestHarness({
    access: options.access ?? 'allowed',
    applicationComposition: { load: Effect.succeed(snapshot) },
    compositionRevision: revision,
    executeOwnerQuery: () => Effect.die('The read runs no owner SQL'),
    expectedDeployment: deployment,
    moduleCallRoute: options.route ?? routeAnswering(restrictedAnswer),
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: hostOf([registration, ...(options.extraReads ?? [])]),
    scope,
  });
  /** Everything of a request but the read: the verified principal of the admitted revision. */
  const request = {
    input: { subject: 'customer' },
    principal: trustVerifiedGatewayPrincipalContext(scope, revision),
    transport: { correlationId: scope.correlationId },
  };
  return { ...harness, request };
});
type Harness = Effect.Success<ReturnType<typeof harnessFor>>;
/** The harness a route stub observes once the harness exists (it is built with the route). */
interface HarnessProbe {
  harness?: Harness;
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isSuccess(exit) ? undefined : Option.getOrUndefined(Cause.findErrorOption(exit.cause));

/** Every transaction the kernel opened: the owner check, each module transaction, the evidence. */
const timedTransactions = (statements: readonly string[]) =>
  statements.filter((statement) => /statement_timestamp\(\)/iu.test(statement)).length;

it.layer(NodeCrypto.layer)('a { run } read on the SDK kernel', (suite) => {
  suite.effect('calls another module, then reads its own data in one transaction', () =>
    Effect.gen(function* callThenTransaction() {
      const probe: HarnessProbe = {};
      const openAtCall: number[] = [];
      const statementsAtCall: number[] = [];
      const route: CallRoute = {
        send: () =>
          Effect.sync(() => {
            openAtCall.push(probe.harness?.openConnections() ?? -1);
            statementsAtCall.push(probe.harness?.snapshot().statements.length ?? -1);
            return restrictedAnswer;
          }),
      };
      const registration = runRead((input, context) =>
        Effect.gen(function* run() {
          const restriction = restrictionOf(yield* context.call('restrictions', { subject: input.subject }));
          const owned = yield* context.transaction((own) => own.load(input.subject));
          return answered({ ...owned, restriction });
        }),
      );
      const harness = yield* harnessFor(registration, { route });
      probe.harness = harness;
      const result = yield* harness.runtime.runRead({ ...harness.request, registration });
      expect(result).toEqual({ restriction: 'NONE', secret: 'owner:customer', state: 'CURRENT' });
      const { evidenceWrites, routedCalls, statements } = harness.snapshot();
      expect(routedCalls).toHaveLength(1);
      expect(routedCalls[0]?.encodedInput).toEqual({ subject: 'customer' });
      // The request's own person, relayed under the requirement's declared Legal Entity scope.
      expect(routedCalls[0]?.caller).toMatchObject({ kind: 'person', legalEntityScope: 'subject' });
      expect(routedCalls[0]?.execution.callerSource.principal).toMatchObject({
        principalId: scope.principalId,
        tenantId,
      });
      // No connection is held while the call is in flight.
      expect(openAtCall).toEqual([0]);
      // The read's own row and one row for its call, written together after run.
      expect(evidenceWrites).toBe(2);
      // The module's transaction, the first one after the call, is READ ONLY from its first statement.
      const [afterCall = -1] = statementsAtCall;
      const moduleMode = statements
        .slice(afterCall)
        .find((statement) => /^set transaction|read (?:only|write)/iu.test(statement));
      expect(moduleMode).toMatch(/read only/iu);
    }),
  );

  suite.effect('relays the receiving audience the read was admitted under with its calls', () =>
    Effect.gen(function* audienceRelayed() {
      const registration = runRead((input, context) =>
        Effect.gen(function* run() {
          const restriction = restrictionOf(yield* context.call('restrictions', { subject: input.subject }));
          return answered({ restriction, state: 'CURRENT' });
        }),
      );
      const harness = yield* harnessFor(registration);
      yield* harness.runtime.runRead({ ...harness.request, audience: 'sdk-kernel-receiver', registration });
      expect(harness.snapshot().routedCalls[0]?.execution.callerSource.audience).toBe('sdk-kernel-receiver');
    }),
  );

  suite.effect('reads, calls, then reads again: two transactions with the call between them', () =>
    Effect.gen(function* transactionCallTransaction() {
      const probe: HarnessProbe = {};
      const openAtCall: number[] = [];
      const route: CallRoute = {
        send: () =>
          Effect.sync(() => {
            openAtCall.push(probe.harness?.openConnections() ?? -1);
            return restrictedAnswer;
          }),
      };
      const registration = runRead((input, context) =>
        Effect.gen(function* run() {
          const first = yield* context.transaction((own) => own.load(input.subject));
          const restriction = restrictionOf(yield* context.call('restrictions', { subject: first.secret }));
          const second = yield* context.transaction((own) => own.load(input.subject));
          return answered({ restriction, secret: second.secret, state: first.state });
        }),
      );
      const harness = yield* harnessFor(registration, { route });
      probe.harness = harness;
      const before = timedTransactions(harness.snapshot().statements);
      const result = yield* harness.runtime.runRead({ ...harness.request, registration });
      expect(result).toEqual({ restriction: 'NONE', secret: 'owner:customer', state: 'CURRENT' });
      const { routedCalls, statements } = harness.snapshot();
      expect(routedCalls.map((request) => request.encodedInput)).toEqual([{ subject: 'owner:customer' }]);
      expect(openAtCall).toEqual([0]);
      // The owner check before run, then the module's two transactions, each with its own clock.
      expect(timedTransactions(statements) - before).toBe(3);
    }),
  );

  suite.effect('refuses a call attempted inside a transaction: nothing is sent, the read is unavailable', () =>
    Effect.gen(function* callInsideTransaction() {
      const registration = runRead((input, context) =>
        context
          .transaction(() => context.call('restrictions', { subject: input.subject }))
          .pipe(Effect.map((outcome) => answered({ restriction: restrictionOf(outcome), state: 'CURRENT' }))),
      );
      const harness = yield* harnessFor(registration);
      const exit = yield* Effect.exit(harness.runtime.runRead({ ...harness.request, registration }));
      expect(Schema.is(ReadHandlerUnavailable)(failureOf(exit))).toBe(true);
      expect(harness.snapshot().routedCalls).toHaveLength(0);
    }),
  );

  suite.effect('a denied own access decision wins over a failing call and an access question', () =>
    Effect.gen(function* deniedFirst() {
      let ran = false;
      const target = defineRead(
        descriptor(OTHER_KEY),
        (_input, context: ReadLoadContext<Services>) =>
          context.services.load('x').pipe(Effect.map((owned) => answered({ ...owned, restriction: 'NONE' }))),
        services,
      );
      const registration = defineRead(
        { ...descriptor(), accessQuestions: { other: canRun(target) }, calls },
        {
          run: (input, context) =>
            Effect.sync(() => {
              ran = true;
            }).pipe(
              Effect.andThen(context.call('restrictions', { subject: input.subject })),
              Effect.map((outcome) => answered({ restriction: restrictionOf(outcome), state: 'CURRENT' })),
            ),
        },
        services,
      );
      const harness = yield* harnessFor(registration, {
        // The read's own capability is denied; the question's target would be allowed.
        access: { [`${OTHER_KEY}.read`]: 'allowed' },
        extraReads: [target],
        route: { send: () => Effect.die('A denied read sends no call') },
      });
      const exit = yield* Effect.exit(harness.runtime.runRead({ ...harness.request, registration }));
      expect(Schema.is(ReadPermissionDenied)(failureOf(exit))).toBe(true);
      expect(ran).toBe(false);
      const { gateTransactions, routedCalls } = harness.snapshot();
      expect(routedCalls).toHaveLength(0);
      // Only the read's own decision was asked: the question never reached the gate.
      expect(gateTransactions).toHaveLength(1);
    }),
  );

  suite.effect('hands a failed call to the module as a typed outcome', () =>
    Effect.gen(function* failedCallAsData() {
      const registration = runRead((input, context) =>
        context.call('restrictions', { subject: input.subject }).pipe(
          Effect.map((outcome) =>
            answered({
              restriction: restrictionOf(outcome),
              state: Option.isSome(callAnswer(outcome)) ? 'CURRENT' : 'UNAVAILABLE',
            }),
          ),
        ),
      );
      const outcomes: readonly (readonly [RouteAnswer, string])[] = [
        [{ _tag: 'Problem', reason: 'no such subject', status: 404 }, 'NotFound'],
        [{ _tag: 'Problem', reason: 'not yours', status: 403 }, 'Forbidden'],
        [{ _tag: 'Problem', code: 'subject_retired', reason: 'retired', status: 409 }, 'Rejected'],
        [{ _tag: 'Unreachable', reason: 'provider down' }, 'Unavailable'],
        [{ _tag: 'Answered', encoded: { unexpected: true } }, 'Unavailable'],
      ];
      for (const [answer, tag] of outcomes) {
        const harness = yield* harnessFor(registration, { route: routeAnswering(answer) });
        expect(yield* harness.runtime.runRead({ ...harness.request, registration })).toEqual({
          restriction: tag,
          state: 'UNAVAILABLE',
        });
        expect(harness.snapshot().evidenceWrites).toBe(2);
      }
    }),
  );

  suite.effect('writes its evidence before release and releases only the field groups the caller may see', () =>
    Effect.gen(function* fieldDenialAtRelease() {
      const registration = runRead((input, context) =>
        Effect.gen(function* run() {
          const restriction = restrictionOf(yield* context.call('restrictions', { subject: input.subject }));
          const owned = yield* context.transaction((own) => own.load(input.subject));
          return answered({ ...owned, restriction });
        }),
      );
      // The read is allowed, its secret field group is not.
      const denied = yield* harnessFor(registration, { access: { [`${READ_KEY}.read`]: 'allowed' } });
      expect(yield* denied.runtime.runRead({ ...denied.request, registration })).toEqual({
        restriction: 'NONE',
        state: 'CURRENT',
      });
      expect(denied.snapshot().evidenceWrites).toBe(2);
      const evidenceAt = denied
        .snapshot()
        .statements.findIndex((statement) =>
          statement.toLowerCase().startsWith('insert into "core"."data_access_events"'),
        );
      expect(evidenceAt).toBeGreaterThan(-1);
      const granted = yield* harnessFor(registration, {
        access: { [`${READ_KEY}.read`]: 'allowed', [SECRET_GROUP_KEY]: 'allowed' },
      });
      expect(yield* granted.runtime.runRead({ ...granted.request, registration })).toEqual({
        restriction: 'NONE',
        secret: 'owner:customer',
        state: 'CURRENT',
      });
    }),
  );
});
