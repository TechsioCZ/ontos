import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { evaluateListAccessPredicate } from '../../src/access/decision/list-access.ts';
import type { ListAccessPredicate, ListRowProjection } from '../../src/access/decision/list-access.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import type { TestGateAnswer } from '../../src/access/enforcement/testing.ts';
import { RecordKeySchema } from '../../src/access/ids.ts';
import {
  preserveSystemPrincipalContextTrust,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import type {
  AccessActorInput,
  AccessDeclarationInput,
  AccessFieldGroupInput,
} from '../../src/authorization/access-declaration.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import type { ReadHandlerContext } from '../../src/reads/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadRegistration } from '../../src/reads/definition.ts';
import { ReadPermissionDenied, ReadPermissionUnavailable } from '../../src/reads/errors.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeTestBoundAccessGate } from '../../src/testing/access-gate.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';
import {
  cell,
  makeAuthority,
  makeCheck,
  person,
  principalHolder,
  RECORD_MODULE,
  tenant,
} from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

/** Module-operation admission refuses a non-Core Read with no bound owner registration. */
const shellOwner = makeTestOperationOwner({ moduleId: 'core.shell' }).ownerRegistration;

/**
 * C21's read-channel proofs: the gate's `ListAccessPredicate` reaches the owner of a row-scoped read
 * (D16, O25, B1) and the field groups a caller lacks are projected out of the result (D14, O58, O17).
 * Every case runs the production read runtime; only the enforcement ports are faked, exactly as a
 * composition fakes them, so the predicate and the projection are the runtime's own behaviour.
 */

const LIST_KEY = 'core.shell.records.list';
const PERSON_KEY = 'core.shell.person.read';
const SALARY_KEY = 'core.shell.person.read-salary';
const RECORD_KEY = 'record-1';
const COMPLETE_HASH = 'b'.repeat(64);

const scope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'better-auth-session:read-access-gate',
    authMethod: 'session',
    principalId: person,
    tenantId: tenant,
  }),
  correlationId: 'correlation-c21',
});
const operationAt = DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-11-03T09:00:00.000Z')));
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";

const declarationOf = (key: string, overrides: Partial<AccessDeclarationInput> = {}): AccessDeclarationInput => ({
  key,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'shell', level: 'basic' },
  risk: 'routine',
  selectors: [],
  ...overrides,
});

const salaryGroup = (overrides: Partial<AccessFieldGroupInput> = {}): AccessFieldGroupInput => ({
  fieldClass: 'salaries',
  fields: ['salary'],
  key: SALARY_KEY,
  kind: 'field_read',
  modes: ['run'],
  placement: { group: 'shell', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

const entrypointFor = (entrypointKey: string) =>
  defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey,
    moduleKey: 'core.shell',
    role: 'api',
  });

interface Row {
  readonly assigned?: typeof person;
  readonly recordKey: string;
  readonly salary?: number;
}

const rows: readonly Row[] = Object.freeze([
  { assigned: person, recordKey: RECORD_KEY, salary: 90_000 },
  { recordKey: 'record-2', salary: 80_000 },
]);

const rowProjection = (row: Row): ListRowProjection =>
  withOptional(
    { recordKey: RecordKeySchema.make(row.recordKey), teamIds: [] },
    'assigned',
    row.assigned === undefined ? undefined : principalHolder(row.assigned),
  );

/** The owner's own row filter: the predicate is the normative contract, applied per row (O25). */
const visibleRows = (listAccess: ListAccessPredicate | undefined, candidates: readonly Row[]): readonly Row[] =>
  listAccess === undefined
    ? candidates
    : candidates.filter((row) => evaluateListAccessPredicate(listAccess, rowProjection(row)));

const listRead = (input: {
  readonly onFactoryListAccess?: (listAccess: ListAccessPredicate | undefined) => void;
  readonly onHandlerContext?: (context: ReadHandlerContext<unknown>) => void;
  readonly onHandlerRun?: () => void;
  readonly withFieldGroup?: boolean;
}) =>
  defineRead(
    withOptional(
      {
        accessDeclaration: declarationOf(LIST_KEY, { selectors: ['assigned'] }),
        accessKind: 'list' as const,
        entrypoint: entrypointFor(LIST_KEY),
        evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: `${LIST_KEY}.v1` },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'forbidden' as const,
        owningModuleKey: 'core.shell',
        permissionTarget: 'module' as const,
        policies: [],
        readKey: LIST_KEY,
        resultSchema: Schema.Array(
          Schema.Struct({ recordKey: RecordKeySchema, salary: Schema.optionalKey(Schema.Number) }),
        ),
        schemaVersion: '1',
      },
      'accessFieldGroups',
      input.withFieldGroup === true ? [salaryGroup()] : undefined,
    ),
    (_input, context) => {
      input.onHandlerRun?.();
      input.onHandlerContext?.(context);
      const visible = visibleRows(context.listAccess, rows);
      return Effect.succeed({
        evidence: { resultCount: visible.length },
        result: visible.map((row) =>
          withOptional({ recordKey: RecordKeySchema.make(row.recordKey) }, 'salary', row.salary),
        ),
      });
    },
    (_transaction, _scope, _revision, listAccess) => {
      input.onFactoryListAccess?.(listAccess);
      return Effect.succeed(Object.freeze({}));
    },
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );

const personRead = (input: {
  readonly accessActor?: AccessActorInput;
  readonly onHandlerContext?: (context: ReadHandlerContext<unknown>) => void;
  readonly withFieldGroup?: boolean;
}) =>
  defineRead(
    withOptional(
      withOptional(
        {
          accessDeclaration: declarationOf(PERSON_KEY, { risk: 'sensitive', selectors: ['all'] }),
          accessKind: 'detail' as const,
          accessTarget: () => ({ moduleKey: RECORD_MODULE, recordKey: RECORD_KEY }),
          entrypoint: entrypointFor(PERSON_KEY),
          evidencePolicy: { captureMode: 'hash_only' as const, policyKey: `${PERSON_KEY}.v1` },
          inputSchema: Schema.Struct({}),
          legalEntityScope: 'forbidden' as const,
          owningModuleKey: 'core.shell',
          permissionTarget: 'module' as const,
          policies: [],
          readKey: PERSON_KEY,
          resultSchema: Schema.Struct({ name: Schema.String, salary: Schema.optionalKey(Schema.Number) }),
          schemaVersion: '1',
        },
        'accessFieldGroups',
        input.withFieldGroup === true ? [salaryGroup()] : undefined,
      ),
      'accessActor',
      input.accessActor,
    ),
    (_input, context) => {
      input.onHandlerContext?.(context);
      return Effect.succeed({
        evidence: {
          resultCount: 1,
          resultFingerprintHash: COMPLETE_HASH,
          resultFingerprintSchema: 'core.shell.person.v1',
        },
        result: { name: 'Ada', salary: 120_000 },
      });
    },
    () => Effect.succeed(Object.freeze({})),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );

/** The real gate over faked ports: the engine resolves the predicate, nothing is scripted. */
const liveGate = (spec: AuthoritySpec): BoundAccessGate => {
  const authority = makeAuthority(spec);
  const check = makeCheck({
    authority: spec,
    records: [{ assigned: principalHolder(), recordKey: RECORD_KEY }],
  });
  const ports = {
    candidates: { listCandidateIds: () => Effect.succeed([]) },
    check: check.port,
    decisionLog: { record: () => Effect.void },
    intent: { authorityFor: () => authority.port },
    principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
  };
  const seam = makeAccessDecisionService({
    authorityFor: ports.intent.authorityFor,
    check: ports.check,
    decisionLog: ports.decisionLog,
    legalEntities: ports.candidates,
    principalKinds: ports.principalKinds,
  });
  return bindAccessGate(seam, ports);
};

/** A scripted gate, for the answers the engine only produces on a dead or unreadable authority. */
const scriptedGate = (answers: Readonly<Record<string, TestGateAnswer>>): BoundAccessGate =>
  makeTestBoundAccessGate({ answers }).bound;

/** One gate answer, including the list answer that carries no predicate at all (the gate contract). */
const answerOf = (outcome: AccessDecision['outcome'], predicate?: ListAccessPredicate): BoundAccessGate => {
  const decision: AccessDecision = { evidence: [], outcome, reasons: [{ code: 'allow.granted' }], selectors: [] };
  return {
    decide: () => Effect.succeed(decision),
    list: () => Effect.succeed(withOptional({ decision }, 'predicate', predicate)),
    selectableLegalEntities: () => Effect.succeed([]),
  };
};

const makeRuntime = Effect.fn('ReadAccessGateSuite.makeRuntime')(function* makeRuntime(
  accessDecision: BoundAccessGate | undefined,
  evidence: { readonly parameterRows: unknown[][] },
  readScope: OperationalScope = scope,
) {
  const database = {
    executor: yield* makeTestDatabase((text, values) => {
      if (text.includes("current_setting('transaction_isolation')")) {
        return Effect.succeed([{ isolation: 'read committed' }]);
      }
      // A session-setting role installs its scope and reads back the connected role in one statement.
      if (text === installAndReadScopeSql) {
        return Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenant }]);
      }
      if (text.includes('transaction_timestamp')) {
        return Effect.succeed([{ operation_at: operationAt }]);
      }
      if (text.includes('data_access_events')) {
        evidence.parameterRows.push([...values]);
        return Effect.succeed([]);
      }
      return text.includes('current_setting')
        ? Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenant }])
        : Effect.succeed([]);
    }),
  };
  return makeReadRuntime(
    database,
    openModuleEntrypointGateway,
    { resolve: () => Effect.succeed(readScope) },
    {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    },
    {
      databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      ownerAuthorizationOverlay: { authorize: () => Effect.succeed('allowed' as const) },
      ownerRegistration: shellOwner,
      ...withOptional({}, 'accessDecision', accessDecision),
    },
  );
});

type ReadRuntimeUnderTest = Effect.Success<ReturnType<typeof makeRuntime>>;

const runRead = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  HandlerError,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  runtime: ReadRuntimeUnderTest,
  registration: ReadRegistration<
    InputSchema,
    ResultSchema,
    Owner,
    Services,
    HandlerError,
    Requirements,
    DomainErrorSchema
  >,
) =>
  runtime.runRead({
    input: {},
    principal: scope,
    registration,
    transport: { correlationId: scope.correlationId },
  });

/** One capture of the evidence rows a read persists, so a suite can read what was recorded. */
interface CapturedEvidence {
  readonly parameterRows: unknown[][];
}

const evidenceCapture = (): CapturedEvidence => ({ parameterRows: [] });

/** The typed failure of one read run, or undefined when the read answered. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

it.effect('filters a selectors-bearing list read with the predicate the gate resolved (O25)', () =>
  Effect.gen(function* predicateChannel() {
    const seenFactory: (ListAccessPredicate | undefined)[] = [];
    const seenHandler: (ListAccessPredicate | undefined)[] = [];
    const runtime = yield* makeRuntime(
      liveGate({ cells: [cell({ capability: LIST_KEY, selector: { _tag: 'assigned' } })] }),
      evidenceCapture(),
    );
    const result = yield* runRead(
      runtime,
      listRead({
        onFactoryListAccess: (listAccess) => {
          seenFactory.push(listAccess);
        },
        onHandlerContext: (context) => {
          seenHandler.push(context.listAccess);
        },
      }),
    );
    // The engine resolved the `assigned` selector into a per-row predicate, and both owner seams saw
    // the very same filter: the service factory that builds the query and the handler that reads it.
    expect(result).toEqual([{ recordKey: RECORD_KEY, salary: 90_000 }]);
    expect(seenFactory).toEqual([
      { groups: [{ clauses: [{ conditions: [{ _tag: 'AssignedTo', holder: principalHolder() }] }] }] },
    ]);
    expect(seenHandler).toEqual(seenFactory);
  }),
);

it.effect('sees nothing when the gate resolves no predicate for an empty team set (B1)', () =>
  Effect.gen(function* emptyTeam() {
    let handlerRuns = 0;
    const seenFactory: (ListAccessPredicate | undefined)[] = [];
    const runtime = yield* makeRuntime(
      liveGate({ cells: [cell({ capability: LIST_KEY, selector: { _tag: 'team' } })], teamMembers: new Map() }),
      evidenceCapture(),
    );
    const exit = yield* Effect.exit(
      runRead(
        runtime,
        listRead({
          onFactoryListAccess: (listAccess) => {
            seenFactory.push(listAccess);
          },
          onHandlerRun: () => {
            handlerRuns += 1;
          },
        }),
      ),
    );
    // A team cell whose holder is in no team cannot describe one matching row, so the read is denied
    // instead of widening into an unfiltered scan of the scope (B1, guarantee 10).
    expect(Schema.is(ReadPermissionDenied)(failureOf(exit))).toBe(true);
    expect(handlerRuns).toBe(0);
    expect(seenFactory).toEqual([]);
  }),
);

it.effect('never widens a list answer without a predicate, and never reads on a denial or a dead engine', () =>
  Effect.gen(function* listNegativeControls() {
    let handlerRuns = 0;
    const registration = listRead({
      onHandlerRun: () => {
        handlerRuns += 1;
      },
    });
    const failureWith = (gate: BoundAccessGate) =>
      Effect.gen(function* runAgainstGate() {
        const runtime = yield* makeRuntime(gate, evidenceCapture());
        return failureOf(yield* Effect.exit(runRead(runtime, registration)));
      });
    // An allowed list answer without a predicate describes no row at all (the gate's own contract),
    // so the read is refused instead of being served unfiltered.
    expect(Schema.is(ReadPermissionDenied)(yield* failureWith(answerOf('ALLOWED')))).toBe(true);
    expect(Schema.is(ReadPermissionDenied)(yield* failureWith(answerOf('DENIED')))).toBe(true);
    expect(Schema.is(ReadPermissionUnavailable)(yield* failureWith(answerOf('UNAVAILABLE')))).toBe(true);
    // Negative control: a composition without the gate refuses the same read with a retryable 503.
    const noGate = yield* makeRuntime(undefined, evidenceCapture());
    expect(Schema.is(ReadPermissionUnavailable)(failureOf(yield* Effect.exit(runRead(noGate, registration))))).toBe(
      true,
    );
    expect(handlerRuns).toBe(0);
  }),
);

it.effect('projects out the fields of a field group the caller lacks, keeping the complete hash (O17)', () =>
  Effect.gen(function* fieldProjection() {
    const granted = yield* makeRuntime(
      liveGate({
        cells: [
          cell({ capability: PERSON_KEY, selector: { _tag: 'all' } }),
          cell({ capability: SALARY_KEY, selector: { _tag: 'all' } }),
        ],
      }),
      evidenceCapture(),
    );
    expect(yield* runRead(granted, personRead({ withFieldGroup: true }))).toEqual({ name: 'Ada', salary: 120_000 });

    const redactedEvidence = evidenceCapture();
    const redacted = yield* makeRuntime(
      liveGate({ cells: [cell({ capability: PERSON_KEY, selector: { _tag: 'all' } })] }),
      redactedEvidence,
    );
    expect(yield* runRead(redacted, personRead({ withFieldGroup: true }))).toEqual({ name: 'Ada' });
    // The projection never weakens integrity: the persisted fingerprint is the owner's hash of the
    // complete payload, and the caller simply does not receive the projected field (O17).
    expect(redactedEvidence.parameterRows.some((row) => row.includes(COMPLETE_HASH))).toBe(true);

    // Negative control: the same read without the field group returns the complete payload.
    expect(yield* runRead(redacted, personRead({}))).toEqual({ name: 'Ada', salary: 120_000 });
  }),
);

it.effect('projects a row-scoped field group out of every row the caller may see (O58, O25)', () =>
  Effect.gen(function* rowScopedFieldGroup() {
    const granted = yield* makeRuntime(
      liveGate({
        cells: [
          cell({ capability: LIST_KEY, selector: { _tag: 'assigned' } }),
          cell({ capability: SALARY_KEY, selector: { _tag: 'all' } }),
        ],
      }),
      evidenceCapture(),
    );
    expect(yield* runRead(granted, listRead({ withFieldGroup: true }))).toEqual([
      { recordKey: RECORD_KEY, salary: 90_000 },
    ]);

    // The row filter and the field projection are two questions: the caller still sees its own row,
    // but without the salary the field group governs.
    const redacted = yield* makeRuntime(
      liveGate({ cells: [cell({ capability: LIST_KEY, selector: { _tag: 'assigned' } })] }),
      evidenceCapture(),
    );
    expect(yield* runRead(redacted, listRead({ withFieldGroup: true }))).toEqual([{ recordKey: RECORD_KEY }]);
  }),
);

it.effect('hands the handler the gate\u2019s own field answer, never the request payload (O17, O25)', () =>
  Effect.gen(function* deniedFieldChannel() {
    const seen: (readonly (readonly string[])[] | 'absent')[] = [];
    const capture = (context: ReadHandlerContext<unknown>) => {
      seen.push(context.deniedFieldPaths ?? 'absent');
    };
    // A caller without the salary group: its handler learns exactly which declared result path is
    // denied, so the owner query it builds can stop matching, ordering and reporting on that surface.
    const denied = yield* makeRuntime(
      liveGate({ cells: [cell({ capability: PERSON_KEY, selector: { _tag: 'all' } })] }),
      evidenceCapture(),
    );
    expect(yield* runRead(denied, personRead({ onHandlerContext: capture, withFieldGroup: true }))).toEqual({
      name: 'Ada',
    });
    // A granted caller receives an empty answer rather than no answer, so an owner can tell a granted
    // field group from a read the gate never decided.
    const grantedRuntime = yield* makeRuntime(
      liveGate({
        cells: [
          cell({ capability: PERSON_KEY, selector: { _tag: 'all' } }),
          cell({ capability: SALARY_KEY, selector: { _tag: 'all' } }),
        ],
      }),
      evidenceCapture(),
    );
    expect(yield* runRead(grantedRuntime, personRead({ onHandlerContext: capture, withFieldGroup: true }))).toEqual({
      name: 'Ada',
      salary: 120_000,
    });
    // A gate-decided read that declares no field group carries its empty answer too.
    expect(yield* runRead(grantedRuntime, personRead({ onHandlerContext: capture }))).toEqual({
      name: 'Ada',
      salary: 120_000,
    });
    expect(seen).toEqual([[['salary']], [], []]);

    // This fixture's empty-object input schema accepts the extra data. Even then, a request cannot
    // overwrite the trusted field answer: the handler still receives the gate's denial and redacts.
    const injected = yield* denied.runRead({
      input: { deniedFieldPaths: [] },
      principal: scope,
      registration: personRead({ onHandlerContext: capture, withFieldGroup: true }),
      transport: { correlationId: scope.correlationId },
    });
    expect(injected).toEqual({ name: 'Ada' });
    expect(seen).toEqual([[['salary']], [], [], [['salary']]]);
  }),
);

it.effect('answers a retryable unavailability when a field group cannot be decided (O48b)', () =>
  Effect.gen(function* fieldUnavailable() {
    const runtime = yield* makeRuntime(
      scriptedGate({ [PERSON_KEY]: { outcome: 'ALLOWED' }, [SALARY_KEY]: { outcome: 'UNAVAILABLE' } }),
      evidenceCapture(),
    );
    expect(
      Schema.is(ReadPermissionUnavailable)(
        failureOf(yield* Effect.exit(runRead(runtime, personRead({ withFieldGroup: true })))),
      ),
    ).toBe(true);
  }),
);

it.effect('projects a governed field out of a payload that carries typed values (O17, O74)', () =>
  Effect.gen(function* projectsTypedPayload() {
    // A result may hold values that are not JSON data at all — a Date, a DateTimeUtcFromString, an
    // Option. A caller who merely lacks one field grant must still receive the payload, minus exactly
    // the field it may not read (the reported defect: the whole read answered 503 instead).
    const typedRead = defineRead(
      {
        accessDeclaration: declarationOf(PERSON_KEY, { risk: 'sensitive', selectors: ['all'] }),
        accessFieldGroups: [salaryGroup()],
        accessKind: 'detail',
        accessTarget: () => ({ moduleKey: RECORD_MODULE, recordKey: RECORD_KEY }),
        entrypoint: entrypointFor(PERSON_KEY),
        evidencePolicy: { captureMode: 'metadata_only', policyKey: `${PERSON_KEY}.v1` },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'forbidden',
        owningModuleKey: 'core.shell',
        permissionTarget: 'module',
        policies: [],
        readKey: PERSON_KEY,
        resultSchema: Schema.Struct({
          name: Schema.String,
          salary: Schema.optionalKey(Schema.Number),
          seenAt: Schema.Date,
        }),
        schemaVersion: '1',
      },
      () =>
        Effect.succeed({
          evidence: { resultCount: 1 },
          result: { name: 'Ada', salary: 120_000, seenAt: operationAt },
        }),
      () => Effect.succeed(Object.freeze({})),
      () => ({ kind: 'module', moduleId: 'core.shell' }),
    );

    const withoutField = yield* makeRuntime(
      scriptedGate({ [PERSON_KEY]: { outcome: 'ALLOWED' }, [SALARY_KEY]: { outcome: 'DENIED' } }),
      evidenceCapture(),
    );
    const projected = yield* runRead(withoutField, typedRead);
    // The governed field is gone; every other value survives as the owner produced it.
    expect(Object.hasOwn(projected, 'salary')).toBe(false);
    expect(projected.name).toBe('Ada');
    expect(projected.seenAt).toStrictEqual(operationAt);

    // The negative control: the caller holding the group receives the complete payload.
    const withField = yield* makeRuntime(
      scriptedGate({ [PERSON_KEY]: { outcome: 'ALLOWED' }, [SALARY_KEY]: { outcome: 'ALLOWED' } }),
      evidenceCapture(),
    );
    const complete = yield* runRead(withField, typedRead);
    expect(complete.salary).toBe(120_000);
  }),
);

/** The scope of a call `core.billing` relays for the person, sealed as the gateway verifier seals it (D4). */
const relayedScope: OperationalScope = (() => {
  const trusted = trustVerifiedGatewayPrincipalContext(scope, 'c'.repeat(64), undefined, {
    appId: 'core.billing',
    buildMarker: 'core-billing-build',
    principalId: '00000000-0000-4000-8000-000000000090',
  });
  return preserveSystemPrincipalContextTrust(trusted, Object.freeze({ ...trusted, correlationId: 'correlation-c21' }));
})();

const relayActor = (subject: AccessActorInput['subject']): AccessActorInput => ({
  callers: ['core.billing'],
  reason: 'Billing shows the person their own record',
  subject,
});

it.effect('decides a relayed identity read\u2019s field group on the subject\u2019s own grant (D6, O17)', () =>
  Effect.gen(function* relayedIdentityFieldGroup() {
    const read = personRead({ accessActor: relayActor('identity'), withFieldGroup: true });
    // The identity read admits its subject without a grant, yet a governed field still needs one.
    const ungranted = yield* makeRuntime(liveGate({ cells: [] }), evidenceCapture(), relayedScope);
    expect(yield* runRead(ungranted, read)).toEqual({ name: 'Ada' });

    const granted = yield* makeRuntime(
      liveGate({
        cells: [
          cell({ capability: PERSON_KEY, selector: { _tag: 'all' } }),
          cell({ capability: SALARY_KEY, selector: { _tag: 'all' } }),
        ],
      }),
      evidenceCapture(),
      relayedScope,
    );
    expect(yield* runRead(granted, read)).toEqual({ name: 'Ada', salary: 120_000 });
  }),
);

it.effect('keeps a relayed rights read deciding its field group on the subject\u2019s grant (D6, O17)', () =>
  Effect.gen(function* relayedRightsFieldGroup() {
    const read = personRead({ accessActor: relayActor('rights'), withFieldGroup: true });
    const redacted = yield* makeRuntime(
      liveGate({ cells: [cell({ capability: PERSON_KEY, selector: { _tag: 'all' } })] }),
      evidenceCapture(),
      relayedScope,
    );
    expect(yield* runRead(redacted, read)).toEqual({ name: 'Ada' });

    const granted = yield* makeRuntime(
      liveGate({
        cells: [
          cell({ capability: PERSON_KEY, selector: { _tag: 'all' } }),
          cell({ capability: SALARY_KEY, selector: { _tag: 'all' } }),
        ],
      }),
      evidenceCapture(),
      relayedScope,
    );
    expect(yield* runRead(granted, read)).toEqual({ name: 'Ada', salary: 120_000 });
  }),
);

const detailReadWithoutTarget = (selectors: readonly ('all' | 'assigned')[]) =>
  defineRead(
    {
      accessDeclaration: declarationOf(PERSON_KEY, { risk: 'sensitive', selectors }),
      accessFieldGroups: [salaryGroup()],
      accessKind: 'detail',
      entrypoint: entrypointFor(PERSON_KEY),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: `${PERSON_KEY}.v1` },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'forbidden',
      owningModuleKey: 'core.shell',
      permissionTarget: 'module',
      policies: [],
      readKey: PERSON_KEY,
      resultSchema: Schema.Struct({ name: Schema.String, salary: Schema.optionalKey(Schema.Number) }),
      schemaVersion: '1',
    },
    () => Effect.succeed({ evidence: { resultCount: 1 }, result: { name: 'Ada' } }),
    () => Effect.succeed(Object.freeze({})),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );

it('refuses a record-scoped read that declares field groups without the record they belong to (D14, O74)', () => {
  // A record-scoped read names the one record its groups are decided with.
  expect(() => detailReadWithoutTarget(['assigned'])).toThrow(/accessTarget/u);
  // A scope-wide read is its own parent read, so its groups need no record at all (O74).
  expect(() => detailReadWithoutTarget([])).not.toThrow();
  // Negative control: a row-scoped read has no single record, and is accepted as declared.
  expect(() => listRead({})).not.toThrow();
});
