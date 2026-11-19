import { Effect, Redacted, Schema } from 'effect';
import { Headers } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ProposalIdSchema } from '../../src/access/ids.ts';
import type { ActionTransportMetadata } from '../../src/actions/context.ts';
import { ActionTransportMetadataSchema } from '../../src/actions/context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionAlreadyCommitted, ActionPermissionDenied } from '../../src/actions/errors.ts';
import type { ActionCoreError } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ActionProposalAcceptedSchema } from '../../src/actions/proposal-accepted.ts';
import type { ActionProposalAccepted } from '../../src/actions/proposal-accepted.ts';
import { ActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeService } from '../../src/actions/runtime.ts';
import {
  bindGovernedActionHttp,
  decodeActionEndpointHeaders,
  runGovernedActionHttp,
} from '../../src/http/http-instrumentation-seam.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { fixtureActionAccess } from '../support/access-declaration-fixtures.ts';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'runner-test',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
});

const BusinessResultSchema = Schema.TaggedStruct('BusinessResult', {});
const ActionInvocationIdSchema = Schema.String.pipe(Schema.brand('ActionInvocationId'), Schema.decodeTo(Schema.String));
const CommittedRetryReceiptSchema = Schema.TaggedStruct('CommittedRetryReceipt', {
  invocationId: ActionInvocationIdSchema,
});

const registration = defineAction(
  {
    // O62: a protected Action must declare its access.
    accessDeclaration: {
      key: 'core.shell.test.http-runner',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'tests', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.test.http-runner.access.v1',
    },
    actionKey: 'core.test.http-runner',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
      entrypointKey: 'core.test.http-runner',
      moduleKey: 'core.shell',
      role: 'action',
    }),
    idempotency: 'optional',
    legalEntityScope: 'optional',
    owningModuleKey: 'core.shell',
    payloadSchema: Schema.Struct({}),
    policies: [],
    resultSchema: BusinessResultSchema,
    schemaVersion: '1',
  },
  () => Effect.succeed(BusinessResultSchema.make({})),
);

const unusedRuntime = (onRun: () => void): ActionRuntimeService => ({
  resolveActionCommit: () => Effect.die('Action commit recovery is outside the runner fixture'),
  runAction: () => {
    onRun();
    return Effect.die('The Action runtime must not be reached');
  },
});

const invalidProblem = { _tag: 'InvalidProblem' as const };
const internalProblem = { _tag: 'InternalProblem' as const };
const authorization = (value?: string) => Redacted.make(value);

const alreadyCommittedRuntime = (failure: ActionAlreadyCommitted): ActionRuntimeService => ({
  resolveActionCommit: () => Effect.die('Action commit recovery is outside the runner fixture'),
  runAction: () => Effect.fail(failure),
});

const acceptedProposal = Schema.decodeSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-04T09:00:00.000Z',
  proposalId: Schema.decodeSync(ProposalIdSchema)('00000000-0000-4000-8000-0000000000a5'),
});

/** A runner that answers the parked 202 the seam must carry as a success, not as a problem. */
const acceptedProposalRuntime = (
  accepted: ActionProposalAccepted,
  seen: ActionTransportMetadata[],
): ActionRuntimeService => ({
  resolveActionCommit: () => Effect.die('Action commit recovery is outside the runner fixture'),
  runAction: (input) => {
    seen.push(Schema.decodeUnknownSync(ActionTransportMetadataSchema)(input.transport));
    return Effect.succeed(accepted);
  },
});

it.effect('invalid correlation metadata is rejected before principal acquisition and runtime lookup', () =>
  Effect.gen(function* rejectInvalidCorrelation() {
    const requestHeaders = [{}, { 'x-correlation-id': '' }, { 'x-correlation-id': '   ' }] as const;
    let authenticationCalls = 0;
    let runtimeCalls = 0;
    const runtime = unusedRuntime(() => {
      runtimeCalls += 1;
    });
    const authenticate = () => {
      authenticationCalls += 1;
      return Effect.succeed(principal);
    };

    for (const headers of requestHeaders) {
      const effect = runGovernedActionHttp({
        endpointHeaders: {
          idempotencyKey: 'not-reached',
          traceId: 'not-reached',
        },
        internalProblem: () => internalProblem,
        invalidCorrelationProblem: () => invalidProblem,
        mapError: () => internalProblem,
        payload: {},
        principal: { authenticate },
        registration,
        requestHeaders: { authorization: authorization(), ...headers },
      }).pipe(Effect.provideService(ActionRuntime, runtime));

      expect(yield* Effect.flip(effect)).toBe(invalidProblem);
    }

    expect(authenticationCalls).toBe(0);
    expect(runtimeCalls).toBe(0);
  }),
);

it.effect('principal authentication failure prevents Action runtime execution', () =>
  Effect.gen(function* rejectAuthenticationFailure() {
    const authenticationProblem = { _tag: 'AuthenticationProblem' as const };
    let runtimeCalls = 0;
    const effect = runGovernedActionHttp({
      endpointHeaders: {
        idempotencyKey: 'not-reached',
        traceId: 'not-reached',
      },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: () => internalProblem,
      payload: {},
      principal: { authenticate: () => Effect.fail(authenticationProblem) },
      registration,
      requestHeaders: {
        authorization: authorization(),
        'x-correlation-id': 'correlation-test',
      },
    }).pipe(
      Effect.provideService(
        ActionRuntime,
        unusedRuntime(() => {
          runtimeCalls += 1;
        }),
      ),
    );

    expect(yield* Effect.flip(effect)).toBe(authenticationProblem);
    expect(runtimeCalls).toBe(0);
  }),
);

it.effect('synchronous endpoint callback defects are sanitized before the Action runtime', () =>
  Effect.gen(function* sanitizeCallbackDefects() {
    const callbackDefects = [
      {
        invalidCorrelationProblem: () => {
          throw new Error('private invalid-problem constructor defect');
        },
        principal: { authenticate: () => Effect.succeed(principal) },
        requestHeaders: {
          authorization: authorization('Bearer private-token'),
        },
      },
      {
        invalidCorrelationProblem: () => invalidProblem,
        principal: {
          authenticate: () => {
            throw new Error('private principal authentication defect');
          },
        },
        requestHeaders: {
          authorization: authorization('Bearer private-token'),
          'x-correlation-id': 'correlation-auth-defect',
        },
      },
    ] as const;
    let runtimeCalls = 0;
    const runtime = unusedRuntime(() => {
      runtimeCalls += 1;
    });

    for (const fixture of callbackDefects) {
      const effect = runGovernedActionHttp({
        endpointHeaders: {
          idempotencyKey: 'not-reached',
          traceId: 'not-reached',
        },
        internalProblem: () => internalProblem,
        invalidCorrelationProblem: fixture.invalidCorrelationProblem,
        mapError: () => internalProblem,
        payload: {},
        principal: fixture.principal,
        registration,
        requestHeaders: fixture.requestHeaders,
      }).pipe(Effect.provideService(ActionRuntime, runtime));

      expect(yield* Effect.flip(effect)).toBe(internalProblem);
    }

    expect(runtimeCalls).toBe(0);
  }),
);

it.effect('takes the admission audience only from receiver configuration', () =>
  Effect.gen(function* receiverAudience() {
    const audiences: (string | undefined)[] = [];
    const runtime: ActionRuntimeService = {
      resolveActionCommit: () => Effect.die('Not exercised'),
      runAction: (input) => {
        audiences.push(input.audience);
        return Effect.die('Stop after observing the trusted boundary');
      },
    };
    const requestHeaders = {
      audience: 'untrusted-request-audience',
      authorization: authorization(),
      'x-correlation-id': 'receiver-audience-test',
    };
    for (const receivingAudience of [{}, { audience: 'test.receiver.api' }]) {
      yield* Effect.exit(
        runGovernedActionHttp({
          ...receivingAudience,
          endpointHeaders: { idempotencyKey: 'test-invocation', traceId: 'test-trace' },
          internalProblem: () => internalProblem,
          invalidCorrelationProblem: () => invalidProblem,
          mapError: () => internalProblem,
          payload: {},
          principal: { authenticate: () => Effect.succeed(principal) },
          registration,
          requestHeaders,
        }),
      ).pipe(Effect.provideService(ActionRuntime, runtime));
    }
    expect(audiences).toEqual([undefined, 'test.receiver.api']);
  }),
);

// ActionAlreadyCommitted now reaches the endpoint only for an invocation committed without a saved reply.
it.effect('allows an endpoint to recover an already committed Action without a saved reply as its success', () =>
  Effect.gen(function* recoverCommittedAction() {
    const committed = new ActionAlreadyCommitted({
      code: 'action_already_committed',
      invocationId: 'committed-invocation',
      reason: 'The Action already committed successfully',
    });
    let mappedErrors = 0;
    const runActionHttp = bindGovernedActionHttp({ authenticate: () => Effect.succeed(principal) });

    const result = yield* runActionHttp({
      endpointHeaders: { idempotencyKey: 'committed-invocation', traceId: 'committed-retry-trace' },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: (_failure: Exclude<ActionCoreError, ActionAlreadyCommitted>) => {
        mappedErrors += 1;
        return internalProblem;
      },
      payload: {},
      recoverAlreadyCommitted: (failure) =>
        CommittedRetryReceiptSchema.make({
          invocationId: failure.invocationId,
        }),
      registration,
      requestHeaders: {
        authorization: authorization(),
        'x-correlation-id': 'committed-retry-test',
      },
    }).pipe(Effect.provideService(ActionRuntime, alreadyCommittedRuntime(committed)));

    expect(Schema.is(CommittedRetryReceiptSchema)(result)).toBe(true);
    expect(result).toHaveProperty('invocationId', 'committed-invocation');
    expect(mappedErrors).toBe(0);
  }),
);

it.effect('maps an already committed Action normally when recovery is not opted into', () =>
  Effect.gen(function* preserveDefaultCommittedMapping() {
    const committed = new ActionAlreadyCommitted({
      code: 'action_already_committed',
      invocationId: 'default-mapping-invocation',
      reason: 'The Action already committed successfully',
    });
    const mappedProblem = { _tag: 'AlreadyCommittedProblem' as const };
    let mappedFailure: unknown;

    const effect = runGovernedActionHttp({
      endpointHeaders: { idempotencyKey: 'default-mapping-invocation', traceId: 'default-mapping-trace' },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: (failure) => {
        mappedFailure = failure;
        return mappedProblem;
      },
      payload: {},
      principal: { authenticate: () => Effect.succeed(principal) },
      registration,
      requestHeaders: {
        authorization: authorization(),
        'x-correlation-id': 'default-committed-mapping-test',
      },
    }).pipe(Effect.provideService(ActionRuntime, alreadyCommittedRuntime(committed)));

    expect(yield* Effect.flip(effect)).toBe(mappedProblem);
    expect(mappedFailure).toBe(committed);
  }),
);

it.effect('answers a parked proposal as the declared 202 success of a proposal transport (O85)', () =>
  Effect.gen(function* transportAcceptedProposal() {
    const seen: ActionTransportMetadata[] = [];
    let mappedErrors = 0;
    const result = yield* runGovernedActionHttp({
      endpointHeaders: { idempotencyKey: 'proposal-invocation', intent: 'propose', traceId: 'proposal-trace' },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: () => {
        mappedErrors += 1;
        return internalProblem;
      },
      payload: {},
      principal: { authenticate: () => Effect.succeed(principal) },
      registration,
      requestHeaders: {
        authorization: authorization(),
        'x-correlation-id': 'proposal-transport-test',
      },
      // The endpoint's own declaration: only this transport shape names the parked 202 (O85).
      successContract: 'result-or-proposal',
    }).pipe(Effect.provideService(ActionRuntime, acceptedProposalRuntime(acceptedProposal, seen)));

    expect(Schema.is(ActionProposalAcceptedSchema)(result)).toBe(true);
    expect(result).toHaveProperty('proposalId', acceptedProposal.proposalId);
    // The intent reaches the one runner through the transport, and the 202 is never a Problem Details body.
    expect(seen).toEqual([
      {
        correlationId: 'proposal-transport-test',
        idempotencyKey: 'proposal-invocation',
        intent: 'propose',
        traceId: 'proposal-trace',
      },
    ]);
    expect(mappedErrors).toBe(0);
  }),
);

it.effect('carries the proposal intent only for the runtime to refuse on a result-only endpoint (O85)', () =>
  Effect.gen(function* transportRefusedProposal() {
    const denied = new ActionPermissionDenied({
      code: 'action_permission_denied',
      reason: 'This Action endpoint does not accept proposal requests',
    });
    const seen: (readonly [ActionTransportMetadata, string | undefined])[] = [];
    const mappedProblem = { _tag: 'ProposalRefusedProblem' as const };
    let mappedFailure: unknown;

    const effect = runGovernedActionHttp({
      endpointHeaders: { idempotencyKey: 'proposal-refused', intent: 'propose', traceId: 'proposal-refused-trace' },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: (failure) => {
        mappedFailure = failure;
        return mappedProblem;
      },
      payload: {},
      principal: { authenticate: () => Effect.succeed(principal) },
      registration,
      requestHeaders: {
        authorization: authorization(),
        'x-correlation-id': 'proposal-refused-test',
      },
    }).pipe(
      Effect.provideService(ActionRuntime, {
        resolveActionCommit: () => Effect.die('Action commit recovery is outside the runner fixture'),
        runAction: (input) => {
          seen.push([Schema.decodeUnknownSync(ActionTransportMetadataSchema)(input.transport), input.successContract]);
          return Effect.fail(denied);
        },
      } satisfies ActionRuntimeService),
    );

    expect(yield* Effect.flip(effect)).toBe(mappedProblem);
    expect(mappedFailure).toBe(denied);
    expect(seen).toEqual([
      [
        {
          correlationId: 'proposal-refused-test',
          idempotencyKey: 'proposal-refused',
          intent: 'propose',
          traceId: 'proposal-refused-trace',
        },
        // The result-only endpoint declares no 202, so the one runner refuses the intent (O85).
        undefined,
      ],
    ]);
  }),
);

it.effect('decodes only the Action transport headers among open browser headers', () =>
  Effect.gen(function* decodeEndpointHeaders() {
    const browserHeaders = Headers.fromInput({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
    });
    const absent = yield* decodeActionEndpointHeaders(browserHeaders);
    expect(absent.idempotencyKey).toBeUndefined();
    expect(absent.traceId).toBeUndefined();
    // Absence omits the key entirely, so a caller never has to tell "no intent" from "undefined intent".
    expect(absent).not.toHaveProperty('intent');
    expect(
      yield* decodeActionEndpointHeaders(
        Headers.setAll(browserHeaders, { 'idempotency-key': 'key-1', 'x-trace-id': 'trace-1' }),
      ),
    ).toEqual({ idempotencyKey: 'key-1', traceId: 'trace-1' });
    // O80: the proposal intent travels beside the other Action transport metadata, as a closed literal.
    expect(
      yield* decodeActionEndpointHeaders(Headers.set(browserHeaders, 'x-action-intent', 'propose')),
    ).toHaveProperty('intent', 'propose');
    const rejectedIntent = yield* Effect.flip(
      decodeActionEndpointHeaders(Headers.set(browserHeaders, 'x-action-intent', 'execute')),
    );
    expect(Schema.isSchemaError(rejectedIntent)).toBe(true);
    for (const rejected of ['', 'k'.repeat(201)]) {
      const failure = yield* Effect.flip(
        decodeActionEndpointHeaders(Headers.set(browserHeaders, 'idempotency-key', rejected)),
      );
      expect(Schema.isSchemaError(failure)).toBe(true);
    }
  }),
);

it.effect('answers a same-key HTTP retry with the original success reply', () =>
  Effect.gen(function* savedReplyOverHttp() {
    let executions = 0;
    const action = defineAction(
      {
        accessDeclaration: fixtureActionAccess('test.http-replay'),
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.http-replay.read.v1' },
        actionKey: 'test.http-replay.create',
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: defineTenantModuleEntrypoint({
          access: 'write',
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
          entrypointKey: 'test.http-replay.create',
          moduleKey: 'test.http-replay',
          role: 'action',
        }),
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'test.http-replay',
        payloadSchema: Schema.Struct({ name: Schema.String }),
        policies: [],
        resultSchema: Schema.Struct({ createdNumber: Schema.Finite, name: Schema.String }),
        schemaVersion: '1',
      },
      (payload) =>
        Effect.sync(() => {
          executions += 1;
          return { createdNumber: executions, name: payload.name };
        }),
    );
    const base = makeModuleContractFixture({ appId: 'test-http-replay', moduleId: 'test.http-replay' }).manifest;
    const ownerRegistration = defineVerticalRuntimeRegistration({
      actions: [action],
      manifest: defineOntosModuleManifest({
        ...base,
        publicSurface: { ...base.publicSurface, actions: [action], api: {}, components: {} },
      }),
      outboxWorkers: [],
    });
    const harness = yield* makeActionTestHarness({ actionPermission: 'allowed', ownerRegistration });
    const mapped: unknown[] = [];
    const replays: string[] = [];
    const send = () =>
      runGovernedActionHttp({
        endpointHeaders: { idempotencyKey: 'create-once', traceId: 'http-replay-trace' },
        internalProblem: () => internalProblem,
        invalidCorrelationProblem: () => invalidProblem,
        mapError: (failure) => {
          mapped.push(failure);
          return internalProblem;
        },
        onReplay: ({ invocationId }) =>
          Effect.sync(() => {
            replays.push(invocationId);
          }),
        payload: { name: 'Acme' },
        principal: { authenticate: () => Effect.succeed(principal) },
        registration: action,
        requestHeaders: { authorization: authorization(), 'x-correlation-id': 'http-replay-test' },
      }).pipe(Effect.provideService(ActionRuntime, harness.runtime));

    const original = yield* send();
    const retry = yield* send();

    expect(original).toEqual({ createdNumber: 1, name: 'Acme' });
    expect(retry).toEqual(original);
    expect(executions).toBe(1);
    expect(mapped).toEqual([]);
    expect(harness.snapshot().committed).toHaveLength(1);
    // The endpoint learns that the retry answered the saved reply; the success itself is unchanged.
    expect(replays).toEqual([harness.snapshot().invocations[0]?.actionInvocationId]);

    // An endpoint that opted into committed-retry recovery gets the saved reply, never its recovery receipt.
    let recoveries = 0;
    const recoveredRetry = yield* runGovernedActionHttp({
      endpointHeaders: { idempotencyKey: 'create-once', traceId: 'http-replay-recovery-trace' },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: (failure: Exclude<ActionCoreError, ActionAlreadyCommitted>) => {
        mapped.push(failure);
        return internalProblem;
      },
      payload: { name: 'Acme' },
      principal: { authenticate: () => Effect.succeed(principal) },
      recoverAlreadyCommitted: (failure) => {
        recoveries += 1;
        return CommittedRetryReceiptSchema.make({ invocationId: failure.invocationId });
      },
      registration: action,
      requestHeaders: { authorization: authorization(), 'x-correlation-id': 'http-replay-recovery-test' },
    }).pipe(Effect.provideService(ActionRuntime, harness.runtime));

    expect(recoveredRetry).toEqual(original);
    expect(recoveries).toBe(0);
    expect(executions).toBe(1);
    expect(mapped).toEqual([]);
    expect(harness.snapshot().committed).toHaveLength(1);

    // An endpoint that withholds saved replies (its handler acts after the Action, and that must not
    // repeat) gets ActionAlreadyCommitted on a same-key retry, never the saved reply.
    const withheldRecovery = yield* runGovernedActionHttp({
      endpointHeaders: { idempotencyKey: 'create-once', traceId: 'http-replay-withheld-recovery-trace' },
      internalProblem: () => internalProblem,
      invalidCorrelationProblem: () => invalidProblem,
      mapError: (failure: Exclude<ActionCoreError, ActionAlreadyCommitted>) => {
        mapped.push(failure);
        return internalProblem;
      },
      onReplay: ({ invocationId }) =>
        Effect.sync(() => {
          replays.push(invocationId);
        }),
      payload: { name: 'Acme' },
      principal: { authenticate: () => Effect.succeed(principal) },
      recoverAlreadyCommitted: (failure) => {
        recoveries += 1;
        return CommittedRetryReceiptSchema.make({ invocationId: failure.invocationId });
      },
      registration: action,
      requestHeaders: { authorization: authorization(), 'x-correlation-id': 'http-replay-withheld-recovery-test' },
      savedReply: 'withhold',
    }).pipe(Effect.provideService(ActionRuntime, harness.runtime));

    const invocationId = harness.snapshot().invocations[0]?.actionInvocationId;
    expect(withheldRecovery).toEqual(CommittedRetryReceiptSchema.make({ invocationId: invocationId ?? '' }));
    expect(recoveries).toBe(1);

    const withheld = yield* Effect.flip(
      runGovernedActionHttp({
        endpointHeaders: { idempotencyKey: 'create-once', traceId: 'http-replay-withheld-trace' },
        internalProblem: () => internalProblem,
        invalidCorrelationProblem: () => invalidProblem,
        mapError: (failure) => {
          mapped.push(failure);
          return internalProblem;
        },
        payload: { name: 'Acme' },
        principal: { authenticate: () => Effect.succeed(principal) },
        registration: action,
        requestHeaders: { authorization: authorization(), 'x-correlation-id': 'http-replay-withheld-test' },
        savedReply: 'withhold',
      }).pipe(Effect.provideService(ActionRuntime, harness.runtime)),
    );

    expect(withheld).toBe(internalProblem);
    expect(mapped).toHaveLength(1);
    const [withheldFailure] = mapped;
    expect(Schema.is(ActionAlreadyCommitted)(withheldFailure)).toBe(true);
    expect(Schema.is(ActionAlreadyCommitted)(withheldFailure) ? withheldFailure.invocationId : undefined).toBe(
      invocationId,
    );
    expect(replays).toEqual([invocationId]);
    expect(executions).toBe(1);
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);
