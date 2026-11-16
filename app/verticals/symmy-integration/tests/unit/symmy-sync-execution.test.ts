import { capturePrivateSymmySyncAdmission } from '../../api/admit-symmy-sync-action-server.ts';
import { SymmySyncAdmissionResponseSchema } from '../../shared/apis/symmy-sync-admission.ts';
import { symmySyncAdmissionRead } from '../../src/api/symmy-sync-admission.read.ts';
import { SymmySyncAdmissionPrivateReceipt } from '../../src/services/symmy-sync-admission-private-receipt.ts';
import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { AdmitSymmySyncResultSchema } from '../../shared/actions/admit-symmy-sync.ts';
import { SymmyEffectAdapters } from '../../src/services/symmy-effect-adapters.service.ts';
import {
  executeSymmySyncAdmission,
  selectSymmySyncOriginalInvocation,
  SymmySyncOriginalInvocationFacts,
} from '../../src/services/symmy-sync-execution.service.ts';
import { symmyJobWorkerUnavailable } from '../../src/services/symmy-job-worker-error.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const effectId = '10000000-0000-4000-8000-000000000002';
const principalId = '10000000-0000-4000-8000-000000000003';
const admissionId = '10000000-0000-4000-8000-000000000004';
const nativeId = '10000000-0000-4000-8000-000000000005';
const routeId = '10000000-0000-4000-8000-000000000006';
const itemId = '10000000-0000-4000-8000-000000000007';
const requestHash = 'a'.repeat(64);
const authContextRef = `job:integration.symmy.execute-symmy-job:run:${admissionId}`;
const admitted = Schema.decodeUnknownSync(AdmitSymmySyncResultSchema)({
  admissionId,
  plan: {
    items: [
      {
        effects: [
          {
            authContextRef,
            effectKey: 'group-create',
            executorBindingIncarnation: '10000000-0000-4000-8000-000000000008',
            executorPrincipalId: principalId,
            intent: {
              _tag: 'CustomerGroupCreate',
              payload: {
                businessCode: 'INTERNAL',
                description: 'Internal group',
                initialState: 'ACTIVE',
                meaningKey: 'INTERNAL_GROUP',
                membershipCriteria: 'Explicit internal source criteria',
                name: 'Internal group',
                purpose: 'Internal classification',
                reason: 'Explicit source definition',
                source: {
                  definitionEvidence: { kind: 'SOURCE_RECORD', reference: 'internal:group-1', revision: 'source-1' },
                  effectId,
                  issuer: 'INTERNAL',
                  mappingRevision: 'mapping-1',
                  namespace: 'groups',
                  order: 1,
                  recordId: 'group-1',
                  revision: 'source-1',
                  route: { id: routeId, revision: 'route-1' },
                  sourceCode: 'INTERNAL',
                },
              },
            },
            itemId,
            ref: {
              effectId,
              mappingVersion: 'mapping-1',
              occurrence: {
                occurrenceId: 'group-occurrence',
                record: {
                  entityKind: 'CUSTOMER_GROUP',
                  issuerId: 'INTERNAL',
                  route: { integrationRouteId: routeId, tenantId },
                  sourceNamespace: 'groups',
                  sourceRecordId: 'group-1',
                },
              },
              operation: {
                entrypointKey: 'commerce.customer-context.create-customer-group',
                moduleId: 'commerce.customer-context',
                schemaVersion: '1',
              },
              routeRevision: 'route-1',
            },
            requestHash,
          },
        ],
        itemId,
        itemKey: 'group',
        unsupportedBranches: [],
      },
    ],
  },
  replayed: false,
  tenantId,
});
const [firstItem] = admitted.plan.items;
const [first] = firstItem.effects;
const query = {
  actionKey: first.ref.operation.entrypointKey,
  authContextRef,
  idempotencyKey: effectId,
  originalPrincipalId: principalId,
  requestHash,
};
const refreshed = (hash = requestHash) =>
  Schema.decodeUnknownSync(Schema.toType(AdmitSymmySyncResultSchema))({
    ...admitted,
    plan: {
      ...admitted.plan,
      items: admitted.plan.items.map((item) => ({
        ...item,
        effects: item.effects.map((effect) => ({
          ...effect,
          originalInvocationId: nativeId,
          originalInvocationStatus: 'succeeded',
          requestHash: hash,
        })),
      })),
    },
    replayed: true,
  });

describe('synchronous fresh original invocation facts', () => {
  it.effect('distinguishes failure before owner dispatch from a possibly committed write', () =>
    Effect.gen(function* ownerFailureBoundary() {
      for (const dispatchPossible of [false, true]) {
        const result = yield* executeSymmySyncAdmission(admitted, 'b'.repeat(64)).pipe(
          Effect.provideService(SymmySyncOriginalInvocationFacts, { read: () => Effect.succeedNone }),
          Effect.provideService(SymmyEffectAdapters, {
            adapters: [
              {
                execute: (input) =>
                  Effect.gen(function* failOwner() {
                    if (dispatchPossible) {
                      yield* input.recordOwnerRequest({
                        authContextRef,
                        executorPrincipalId: principalId,
                        requestHash,
                      });
                    }
                    return yield* symmyJobWorkerUnavailable();
                  }),
                operation: first.ref.operation,
                recover: () => Effect.fail(symmyJobWorkerUnavailable()),
              },
            ],
          }),
        );
        expect(result.items[0].effects[0].status).toBe(dispatchPossible ? 'indeterminate' : 'unavailable');
      }
    }),
  );
  it.effect('reads the just-committed current native identity instead of reusing the pre-admission snapshot', () =>
    Effect.gen(function* actualFreshCapability() {
      const stages: string[] = [];
      const result = yield* executeSymmySyncAdmission(admitted, 'b'.repeat(64)).pipe(
        Effect.provideService(SymmySyncOriginalInvocationFacts, {
          read: (requested) =>
            Effect.gen(function* freshRead() {
              stages.push('fresh-governed-read');
              return yield* selectSymmySyncOriginalInvocation(admitted, refreshed(), requested);
            }),
        }),
        Effect.provideService(SymmyEffectAdapters, {
          adapters: [
            {
              execute: (input) =>
                Effect.gen(function* nativeAck() {
                  stages.push('native-ack');
                  const fact = yield* input.readOriginalActionInvocation(query);
                  expect(Option.getOrUndefined(fact)).toEqual({ actionInvocationId: nativeId, status: 'succeeded' });
                  return {
                    effectId: first.ref.effectId,
                    owner: first.ref.operation.moduleId,
                    status: 'accepted_change',
                  };
                }),
              operation: first.ref.operation,
              recover: () => Effect.fail(symmyJobWorkerUnavailable()),
            },
          ],
        }),
      );
      expect(result.items[0].effects[0].status).toBe('accepted_change');
      expect(stages).toEqual(['native-ack', 'fresh-governed-read']);
      expect(first.originalInvocationId).toBeUndefined();
    }),
  );
  it.effect('rejects a changed plan or native request fingerprint without replacing the admitted intent', () =>
    Effect.gen(function* unchangedPlan() {
      const changed = yield* selectSymmySyncOriginalInvocation(admitted, refreshed('c'.repeat(64)), query).pipe(
        Effect.result,
      );
      expect(Result.isFailure(changed)).toBe(true);
      const wrongActor = yield* selectSymmySyncOriginalInvocation(admitted, refreshed(), {
        ...query,
        originalPrincipalId: '10000000-0000-4000-8000-000000000099',
      }).pipe(Effect.result);
      expect(Result.isFailure(wrongActor)).toBe(true);
    }),
  );
  it.effect('reports absence without inventing a business original invocation identifier', () =>
    Effect.gen(function* absence() {
      const actual = yield* selectSymmySyncOriginalInvocation(admitted, { ...admitted, replayed: true }, query);
      expect(Option.isNone(actual)).toBe(true);
    }),
  );
});

describe('private synchronous admission receipt capture', () => {
  it.effect('keeps the governed public contract minimal while consuming private data after its successful read', () =>
    Effect.gen(function* privateAfterCommit() {
      expect(symmySyncAdmissionRead.descriptor.resultSchema).toBe(SymmySyncAdmissionResponseSchema);
      const publicResponse = Schema.decodeUnknownSync(symmySyncAdmissionRead.descriptor.resultSchema)(admitted);
      expect(publicResponse).toEqual({ admissionId: admitted.admissionId, replayed: admitted.replayed });
      const receipt = yield* capturePrivateSymmySyncAdmission(
        Effect.gen(function* committedRead() {
          const capture = yield* SymmySyncAdmissionPrivateReceipt;
          yield* capture.capture(admitted);
          return publicResponse;
        }),
      );
      expect(receipt).toEqual(admitted);
      expect(receipt.plan.items[0].effects[0].ref.effectId).toBe(effectId);
    }),
  );
  it.effect('discards captured data if the governed read fails before completing', () =>
    Effect.gen(function* noFailedContinuation() {
      let continued = false;
      const result = yield* capturePrivateSymmySyncAdmission(
        Effect.gen(function* rolledBackRead() {
          const capture = yield* SymmySyncAdmissionPrivateReceipt;
          yield* capture.capture(admitted);
          return yield* symmyJobWorkerUnavailable();
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            continued = true;
          }),
        ),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(continued).toBe(false);
    }),
  );
  it.effect('fails closed when no private owner receipt accompanied the successful minimal read', () =>
    Effect.gen(function* absentPrivateData() {
      const result = yield* capturePrivateSymmySyncAdmission(
        Effect.succeed({ admissionId: admitted.admissionId, replayed: admitted.replayed }),
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
  it.effect('refuses a public result identifying a different captured admission', () =>
    Effect.gen(function* noCrossAdmissionCapture() {
      const response = Schema.decodeUnknownSync(SymmySyncAdmissionResponseSchema)({
        admissionId: '10000000-0000-4000-8000-000000000099',
        replayed: false,
      });
      const result = yield* capturePrivateSymmySyncAdmission(
        Effect.gen(function* mismatchedRead() {
          const capture = yield* SymmySyncAdmissionPrivateReceipt;
          yield* capture.capture(admitted);
          return response;
        }),
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
