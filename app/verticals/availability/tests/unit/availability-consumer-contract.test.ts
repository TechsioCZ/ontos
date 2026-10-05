import { RequestSchemaProblemSchema } from '@app/shared-contracts/problem-details';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { currentAvailabilityRead } from '../../src/api/current-availability.read.ts';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import {
  CurrentAvailabilityApi,
  CurrentAvailabilityAuthenticationProblemSchema,
  CurrentAvailabilityForbiddenProblemSchema,
  CurrentAvailabilityInternalProblemSchema,
  CurrentAvailabilityInvalidProblemSchema,
  CurrentAvailabilityNotFoundProblemSchema,
  CurrentAvailabilityPolicyConflictProblemSchema,
  CurrentAvailabilityPolicyProblemSchema,
  CurrentAvailabilityUnavailableProblemSchema,
} from '../../shared/apis/current-availability.ts';
import { availabilityCurrentnessService } from '../../src/services/availability-currentness.service.ts';
import {
  ModuleStateDeniedError,
  OperationContextUnavailable,
  ReadPermissionDenied,
  ReadRuntime,
  ReadHandlerUnavailable,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { Context, Effect, Layer, Match, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { Headers, HttpServerRequest, FetchHttpClient } from 'effect/unstable/http';
import {
  AvailabilityConsumerRequestSchema,
  AvailabilityConsumerResponseSchema,
} from '../../shared/domain/availability-consumer-contract.ts';
import { AvailabilityConsumerOwner } from '../../shared/domain/availability-consumer-owner-port.ts';
import { availabilityMaterialOwners } from '../../shared/domain/availability-currentness.ts';
import { AvailabilityOwnerEvidenceUnavailable } from '../../shared/domain/availability-owner-ports.ts';
import {
  availabilityConsumerContractService,
  AvailabilityConsumerOwnerUnavailableLive,
  availabilityConsumerCurrentnessLive,
} from '../../src/services/availability-consumer-contract.service.ts';
import { executeCurrentAvailabilityWithAuthorization } from '../../src/api/current-availability-client.ts';
import { makeCurrentnessInput } from '../support/availability-currentness.ts';

const currentAvailabilityProblems = makeGovernedReadProblems({
  authentication: CurrentAvailabilityAuthenticationProblemSchema,
  forbidden: CurrentAvailabilityForbiddenProblemSchema,
  internal: CurrentAvailabilityInternalProblemSchema,
  invalid: CurrentAvailabilityInvalidProblemSchema,
  notFound: CurrentAvailabilityNotFoundProblemSchema,
  policyConflict: CurrentAvailabilityPolicyConflictProblemSchema,
  policyIneligible: CurrentAvailabilityPolicyProblemSchema,
  unavailable: CurrentAvailabilityUnavailableProblemSchema,
});
const base = makeCurrentnessInput(['3'], '2');
const seller = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const verified = base.subject.purchasingContext.contextVerification;
const subject = {
  ...base.subject,
  purchasingContext: {
    contextVerification: {
      ...verified,
      evidence: { ...verified.evidence, verifiedScope: { ...verified.evidence.verifiedScope, legalEntityId: seller } },
      request: {
        ...verified.request,
        purchasingContext: { ...verified.request.purchasingContext, sellingLegalEntityId: seller },
      },
    },
  },
};
const input = {
  ...base,
  ownerQualification: { ...base.ownerQualification, subject },
  policy: { ...base.policy, subject },
  subject,
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authContextRef: 'session:test',
    authMethod: 'session',
    legalEntityId: seller,
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId: subject.selection.productRef.tenantId,
  }),
  correlationId: 'availability-test',
};
const request = Schema.decodeUnknownSync(AvailabilityConsumerRequestSchema)({
  contextResolutionRef: 'context-request',
  quantity: subject.quantity,
  representedInBundle: false,
  requestedUse: 'CHECKOUT_SUBMISSION',
  selection: subject.selection,
});
const owner: typeof AvailabilityConsumerOwner.Service = {
  readCurrent: () => Effect.succeed(input),
  resolve: (value) =>
    Effect.succeed({
      evaluatedAt: base.useBoundary.requiredAt,
      representedInBundle: value.representedInBundle,
      subject,
      useBoundary: { ...base.useBoundary, kind: value.requestedUse },
    }),
  verify: (value) =>
    Effect.succeed({
      _tag: 'VALID',
      coherence: 'OWNER_VERIFIED_COHERENT',
      evidence: value.evidence,
      materialEvidence: availabilityMaterialOwners.map((materialOwner) => ({
        businessAt: base.useBoundary.requiredAt,
        contractRef: `${materialOwner}-contract`,
        evidenceRef: `${materialOwner}-proof`,
        invalidationConditions: ['OWNER_MATERIAL_CHANGE'],
        observedAt: base.useBoundary.requiredAt,
        owner: materialOwner,
        sourceRevisionRefs: ['R1'],
        validFrom: base.useBoundary.requiredAt,
      })),
      subject: value.subject,
      useBoundary: value.useBoundary,
    }),
};
const revisionTwo = (proof: Effect.Success<ReturnType<typeof owner.verify>>) =>
  Match.value(proof).pipe(
    Match.tag('VALID', (valid) => ({
      ...valid,
      materialEvidence: valid.materialEvidence.map((entry) => ({ ...entry, sourceRevisionRefs: ['R2'] })),
    })),
    Match.orElse((other) => other),
  );
const previousDecision = (kind: typeof request.requestedUse = 'INFORMATIONAL') =>
  availabilityCurrentnessService({
    evaluatedAt: base.useBoundary.requiredAt,
    representedInBundle: false,
    subject,
    useBoundary: { ...base.useBoundary, kind },
  }).pipe(
    Effect.provide(
      availabilityConsumerCurrentnessLive.pipe(Layer.provide(Layer.succeed(AvailabilityConsumerOwner, owner))),
    ),
    Effect.map((result) => result.currentDecision),
  );
const run = (value = request, resolvedOwner = owner) =>
  availabilityConsumerContractService(value, scope).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(AvailabilityConsumerOwner, resolvedOwner),
        availabilityConsumerCurrentnessLive.pipe(
          Layer.provide(Layer.succeed(AvailabilityConsumerOwner, resolvedOwner)),
        ),
      ),
    ),
  );

describe('Availability public consumer handoff', () => {
  it.effect('round-trips exact provider-neutral result and strips private Inventory and guest authority', () =>
    Effect.gen(function* roundTrip() {
      const response = yield* run();
      const encoded = yield* Schema.encodeEffect(AvailabilityConsumerResponseSchema)(response);
      expect(yield* Schema.decodeEffect(AvailabilityConsumerResponseSchema)(encoded)).toEqual(response);
      expect(response.currentDecision.outcome).toBe('AVAILABLE');
      expect(response.currentDecision.quantity).toEqual(request.quantity);
      expect(response.currentDecision.purchasingContext.scope.legalEntityId).toBe(seller);
      expect(response.currentDecision.authority).toBe('CURRENT_EXACT_USE');
      expect(response.currentDecision.reservationProof).toBe('NOT_PROVIDED');
      const serialized = JSON.stringify(encoded);
      for (const privateField of [
        'stockInput',
        'sourceEvidence',
        'backendId',
        'positionRef',
        'guestSessionRef',
        'subjectAuthority',
      ]) {
        expect(serialized).not.toContain(privateField);
      }
    }),
  );
  for (const amount of ['0', '-1', '01', '1e2', '0.00']) {
    it.effect(`rejects invalid exact quantity ${amount} at public codec`, () =>
      Effect.gen(function* invalidQuantity() {
        const decoded = yield* Schema.decodeUnknownEffect(AvailabilityConsumerRequestSchema)({
          ...request,
          quantity: { ...request.quantity, amount },
        }).pipe(Effect.result);
        expect(Result.isFailure(decoded)).toBe(true);
      }),
    );
  }
  it.effect('Storefront informational result cannot become Checkout authority', () =>
    Effect.gen(function* informational() {
      const response = yield* run({ ...request, requestedUse: 'INFORMATIONAL' });
      expect(response.currentDecision.outcome).toBe('AVAILABLE');
      expect(response.currentDecision.authority).toBe('INFORMATIONAL_ONLY');
      expect(response.currentDecision.useBoundary.kind).toBe('INFORMATIONAL');
    }),
  );
  it.effect('required business evidence outage is uncertainty while unresolved trust stays a typed failure', () =>
    Effect.gen(function* outage() {
      const uncertain = yield* run(request, {
        ...owner,
        readCurrent: () => Effect.fail(new AvailabilityOwnerEvidenceUnavailable({ owner: 'INVENTORY' })),
      });
      expect(uncertain.currentDecision.outcome).toBe('INDETERMINATE');
      expect(uncertain.currentDecision.authority).toBe('UNPROVEN');
      const denied = yield* availabilityConsumerContractService(request, scope).pipe(
        Effect.provide(
          Layer.mergeAll(
            AvailabilityConsumerOwnerUnavailableLive,
            availabilityConsumerCurrentnessLive.pipe(Layer.provide(AvailabilityConsumerOwnerUnavailableLive)),
          ),
        ),
        Effect.result,
      );
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied)) {
        expect(Schema.is(ReadHandlerUnavailable)(denied.failure)).toBe(true);
      }
    }),
  );
  it.effect('rejects cross-context scope and substituted quantity before reading evidence', () =>
    Effect.gen(function* scopeMismatch() {
      let reads = 0;
      const readCurrent = () => {
        reads += 1;
        return Effect.succeed(input);
      };
      for (const invalidSubject of [
        { ...subject, quantity: { ...subject.quantity, amount: '5' } },
        {
          ...subject,
          purchasingContext: {
            contextVerification: {
              ...subject.purchasingContext.contextVerification,
              evidence: {
                ...subject.purchasingContext.contextVerification.evidence,
                verifiedScope: {
                  ...subject.purchasingContext.contextVerification.evidence.verifiedScope,
                  legalEntityId: 'different-seller',
                },
              },
            },
          },
        },
      ]) {
        const result = yield* run(request, {
          ...owner,
          readCurrent,
          resolve: () =>
            Effect.succeed({
              evaluatedAt: base.useBoundary.requiredAt,
              representedInBundle: false,
              subject: invalidSubject,
              useBoundary: { ...base.useBoundary, kind: 'CHECKOUT_SUBMISSION' },
            }),
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
      }
      expect(reads).toBe(0);
    }),
  );
  it.effect('Search hit, omission and historical Order identifiers always resolve new Current owner evidence', () =>
    Effect.gen(function* projectionNonAuthority() {
      let reads = 0;
      const fresh = {
        ...owner,
        readCurrent: () => {
          reads += 1;
          return Effect.succeed(input);
        },
      };
      for (const contextResolutionRef of ['search-hit', 'search-omission', 'repeat-order:accepted-history']) {
        const result = yield* run({ ...request, contextResolutionRef }, fresh);
        expect(result.currentDecision.outcome).toBe('AVAILABLE');
        expect(result.currentDecision.authority).toBe('CURRENT_EXACT_USE');
      }
      expect(reads).toBe(3);
    }),
  );
  it.effect('changed included evidence requires Bundle replacement without patching original history', () =>
    Effect.gen(function* replacement() {
      const ownerLayer = Layer.succeed(AvailabilityConsumerOwner, owner);
      const previous = (yield* availabilityCurrentnessService({
        evaluatedAt: base.useBoundary.requiredAt,
        representedInBundle: false,
        subject,
        useBoundary: { ...base.useBoundary, kind: 'INFORMATIONAL' },
      }).pipe(Effect.provide(availabilityConsumerCurrentnessLive.pipe(Layer.provide(ownerLayer))))).currentDecision;
      let verifications = 0;
      const changedOwner = {
        ...owner,
        resolve: (value: typeof request) =>
          owner.resolve(value, scope).pipe(Effect.map((resolved) => ({ ...resolved, previous }))),
        verify: (value: Parameters<typeof owner.verify>[0]) => {
          verifications += 1;
          return verifications === 1
            ? Effect.succeed({ _tag: 'INVALID' as const, reason: 'MATERIAL_CHANGED' })
            : owner.verify(value).pipe(Effect.map((proof) => revisionTwo(proof)));
        },
      };
      const result = yield* run(
        { ...request, previousResultRef: 'attempt-A:R1', representedInBundle: true },
        changedOwner,
      );
      expect(result.bundleDisposition).toBe('REPLACEMENT_REQUIRED');
      expect(result.originalDecision?.materialEvidence[0]?.sourceRevisionRefs).toEqual(['R1']);
      expect(result.currentDecision.materialEvidence[0]?.sourceRevisionRefs).toEqual(['R2']);
      expect(result.originalDecision?.authority).toBe('HISTORICAL_ONLY');
      expect(result.currentDecision.reservationProof).toBe('NOT_PROVIDED');
    }),
  );
  it.effect('foreign-context history is rejected before any owner read or public disclosure', () =>
    Effect.gen(function* crossContextHistory() {
      const previous = yield* previousDecision();
      const context = subject.purchasingContext.contextVerification;
      const newSubject = {
        ...subject,
        purchasingContext: {
          contextVerification: {
            ...context,
            evidence: {
              ...context.evidence,
              verifiedScope: { ...context.evidence.verifiedScope, channelId: 'wholesale' },
            },
            request: {
              ...context.request,
              purchasingContext: { ...context.request.purchasingContext, channelId: 'wholesale' },
            },
          },
        },
      };
      const newInput = {
        ...input,
        ownerQualification: { ...input.ownerQualification, subject: newSubject },
        policy: { ...input.policy, subject: newSubject },
        subject: newSubject,
      };
      let reads = 0;
      const changed = {
        ...owner,
        readCurrent: () => {
          reads += 1;
          return Effect.succeed(newInput);
        },
        resolve: (value: typeof request) =>
          owner.resolve(value, scope).pipe(Effect.map((resolved) => ({ ...resolved, previous, subject: newSubject }))),
      };
      const response = yield* run({ ...request, previousResultRef: 'cart-old-channel' }, changed).pipe(Effect.result);
      expect(reads).toBe(0);
      expect(Result.isFailure(response)).toBe(true);
      if (Result.isFailure(response)) {
        expect(Schema.is(ReadHandlerUnavailable)(response.failure)).toBe(true);
      }
    }),
  );
  for (const kind of ['CHECKOUT_SUBMISSION', 'ORDER_COMMITMENT'] as const) {
    it.effect(`retained ${kind} history cannot authorize a new request after material invalidation`, () =>
      Effect.gen(function* invalidatedAuthority() {
        const previous = yield* previousDecision(kind);
        let verifications = 0;
        const changed = {
          ...owner,
          resolve: (value: typeof request) =>
            owner.resolve(value, scope).pipe(Effect.map((resolved) => ({ ...resolved, previous }))),
          verify: (value: Parameters<typeof owner.verify>[0]) => {
            verifications += 1;
            return verifications === 1
              ? Effect.succeed({ _tag: 'INVALID' as const, reason: 'MATERIAL_CHANGED' })
              : owner.verify(value).pipe(Effect.map(revisionTwo));
          },
        };
        const response = yield* run({ ...request, representedInBundle: true, requestedUse: kind }, changed);
        expect(response.currentDecision.authority).toBe('CURRENT_EXACT_USE');
        expect(response.originalDecision?.authority).toBe('HISTORICAL_ONLY');
        expect(response.originalDecision?.outcome).toBe('AVAILABLE');
        expect(response.originalDecision?.materialEvidence).toEqual(previous.materialEvidence);
        expect(response.originalDecision?.useBoundary).toEqual(previous.decision.useBoundary);
        expect(response.bundleDisposition).toBe('REPLACEMENT_REQUIRED');
      }),
    );
    it.effect(`retained ${kind} history cannot authorize a new request when owner validity is unproven`, () =>
      Effect.gen(function* unprovenAuthority() {
        const previous = yield* previousDecision(kind);
        const uncertain = {
          ...owner,
          resolve: (value: typeof request) =>
            owner.resolve(value, scope).pipe(Effect.map((resolved) => ({ ...resolved, previous }))),
          verify: () => Effect.fail(new AvailabilityOwnerEvidenceUnavailable({ owner: 'INVENTORY' })),
        };
        const response = yield* run({ ...request, requestedUse: kind }, uncertain);
        expect(response.currentDecision.outcome).toBe('INDETERMINATE');
        expect(response.currentDecision.authority).toBe('UNPROVEN');
        expect(response.originalDecision?.authority).toBe('HISTORICAL_ONLY');
        expect(response.originalDecision?.outcome).toBe('AVAILABLE');
        expect(response.originalDecision?.materialEvidence).toEqual(previous.materialEvidence);
      }),
    );
  }
  for (const [status, tag] of [
    [400, 'CurrentAvailabilityInvalidProblem'],
    [401, 'CurrentAvailabilityAuthenticationProblem'],
    [403, 'CurrentAvailabilityForbiddenProblem'],
    [409, 'CurrentAvailabilityPolicyConflictProblem'],
    [422, 'CurrentAvailabilityPolicyProblem'],
    [503, 'CurrentAvailabilityUnavailableProblem'],
  ] as const) {
    it.effect(`generated Effect client retains declared ${status} failure`, () =>
      Effect.gen(function* clientProblem() {
        const fakeFetch: typeof fetch = () =>
          Promise.resolve(
            Response.json(
              {
                _tag: tag,
                detail: 'Unavailable',
                retryable: status === 503 ? true : undefined,
                status,
                title: 'Request failure',
                type: 'about:blank',
              },
              { headers: { 'content-type': 'application/problem+json' }, status },
            ),
          );
        const result = yield* executeCurrentAvailabilityWithAuthorization(request, 'Bearer controlled', 'client-test', {
          baseUrl: 'https://availability.example/availability-api',
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(Schema.is(Schema.TaggedStruct(tag, { status: Schema.Literal(status) }))(result.failure)).toBe(true);
        }
      }),
    );
  }
  it.effect('generated client preserves decoding and transport failures as typed failures', () =>
    Effect.gen(function* transport() {
      for (const fakeFetch of [
        (() =>
          Promise.resolve(
            new Response('{}', { headers: { 'content-type': 'application/json' } }),
          )) satisfies typeof fetch,
        (() => Promise.reject(new TypeError('Controlled network failure'))) satisfies typeof fetch,
      ]) {
        const result = yield* executeCurrentAvailabilityWithAuthorization(request, 'Bearer controlled', 'client-test', {
          baseUrl: 'https://availability.example/availability-api',
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.result);
        expect(Result.isFailure(result)).toBe(true);
      }
    }),
  );
});

describe('Availability governed server seam', () => {
  for (const failure of [
    new ModuleStateDeniedError({ code: 'module_state_denied', reason: 'private module diagnostics' }),
    new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'private permission diagnostics' }),
    new OperationContextUnavailable({ code: 'operation_context_unavailable', reason: 'private context diagnostics' }),
  ]) {
    it.effect(`maps ${failure.name} before owner business resolution`, () =>
      Effect.gen(function* governedDenial() {
        let ownerResolutionCalls = 0;
        const handler = makeGovernedReadHttpHandler({
          authenticatePrincipal: () => Effect.succeed(scope),
          problems: currentAvailabilityProblems,
          registration: currentAvailabilityRead,
        });
        const result = yield* handler({
          payload: request,
          request: {
            headers: Headers.fromInput({ authorization: 'Bearer controlled', 'x-correlation-id': 'server-test' }),
          },
        }).pipe(
          Effect.provideService(ReadRuntime, { runRead: () => Effect.fail(failure) }),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request('https://availability.example/reads/current-availability')),
          ),
          Effect.provideService(AvailabilityConsumerOwner, {
            ...owner,
            resolve: () => {
              ownerResolutionCalls += 1;
              return owner.resolve(request, scope);
            },
          }),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.status).toBe(Schema.is(OperationContextUnavailable)(failure) ? 503 : 403);
          expect(JSON.stringify(result.failure)).not.toContain('private');
        }
        expect(ownerResolutionCalls).toBe(0);
      }),
    );
  }
  it.effect('requires authentication before Core or business acquisition', () =>
    Effect.gen(function* authenticateFirst() {
      let coreCalls = 0;
      const handler = makeGovernedReadHttpHandler({
        authenticatePrincipal: (_credential, problems) => Effect.fail(problems.authentication()),
        problems: currentAvailabilityProblems,
        registration: currentAvailabilityRead,
      });
      const result = yield* handler({
        payload: request,
        request: { headers: Headers.fromInput({ 'x-correlation-id': 'server-test' }) },
      }).pipe(
        Effect.provideService(ReadRuntime, {
          runRead: () => {
            coreCalls += 1;
            return Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'unused' }));
          },
        }),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://availability.example/reads/current-availability')),
        ),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.status).toBe(401);
      }
      expect(coreCalls).toBe(0);
    }),
  );
});

it.effect('real HTTP codec failures produce declared sanitized Problem Details decoded by the generated client', () =>
  Effect.gen(function* actualPayloadFailure() {
    let authenticationCalls = 0;
    let coreCalls = 0;
    const handler = makeGovernedReadHttpHandler({
      authenticatePrincipal: () => {
        authenticationCalls += 1;
        return Effect.succeed(scope);
      },
      problems: currentAvailabilityProblems,
      registration: currentAvailabilityRead,
    });
    const handlers = HttpApiBuilder.group(CurrentAvailabilityApi, 'currentAvailability', (routes) =>
      routes.handle('execute', handler),
    );
    const unusedRuntimeService = {
      runRead: () => {
        coreCalls += 1;
        return Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'unused' }));
      },
    };
    const unusedRuntime = Layer.succeed(ReadRuntime, unusedRuntimeService);
    const requestContext = Context.make(ReadRuntime, unusedRuntimeService);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(CurrentAvailabilityApi).pipe(
            Layer.provide(handlers),
            Layer.provideMerge(RequestSchemaProblemLive),
            Layer.provide(unusedRuntime),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
    );
    const badPayload = { ...request, quantity: { ...request.quantity, amount: '0' } };
    const direct = yield* Effect.promise(() =>
      server.handler(
        new Request('https://availability.example/reads/current-availability', {
          body: JSON.stringify(badPayload),
          headers: { 'content-type': 'application/json', 'x-correlation-id': 'invalid-http-test' },
          method: 'POST',
        }),
        requestContext,
      ),
    );
    expect(direct.status).toBe(400);
    expect(direct.headers.get('content-type')).toContain('application/problem+json');
    const problem = yield* Effect.promise(() => direct.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RequestSchemaProblemSchema)),
    );
    expect(problem.paths).toContain('quantity');
    expect(JSON.stringify(problem)).not.toContain('context-request');
    const fakeFetch: typeof fetch = (url, init) =>
      server.handler(new Request(url, { ...init, body: JSON.stringify(badPayload) }), requestContext);
    const clientResult = yield* executeCurrentAvailabilityWithAuthorization(request, 'Bearer controlled', 'http-test', {
      baseUrl: 'https://availability.example',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.result);
    expect(Result.isFailure(clientResult)).toBe(true);
    if (Result.isFailure(clientResult)) {
      expect(Schema.is(RequestSchemaProblemSchema)(clientResult.failure)).toBe(true);
    }
    expect(authenticationCalls).toBe(0);
    expect(coreCalls).toBe(0);
  }),
);
