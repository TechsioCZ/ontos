import { Effect, Schema } from 'effect';
import type { ActionHandlerContext } from '@app/core-runtime';
import { ActionTransactionError, ReadRuntime, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { describe, expect, it } from 'effect-rstest';

import {
  ChangeProductManufacturerPayloadSchema,
  RemoveProductManufacturerPayloadSchema,
  SetProductManufacturerPayloadSchema,
} from '../../shared/actions/manufacturer-mutations.ts';
import {
  handleSetProductManufacturer,
  setProductManufacturerAction,
} from '../../src/actions/set-product-manufacturer.action.ts';
import {
  changeProductManufacturerAction,
  handleChangeProductManufacturer,
} from '../../src/actions/change-product-manufacturer.action.ts';
import {
  handleRemoveProductManufacturer,
  removeProductManufacturerAction,
} from '../../src/actions/remove-product-manufacturer.action.ts';
import { ManufacturerPersistenceUnavailable } from '../../src/persistence/manufacturer-persistence.ts';
import type { ManufacturerPersistence } from '../../src/persistence/manufacturer-persistence.ts';
import { ManufacturerTargetForbidden } from '../../src/persistence/manufacturer-target-forbidden.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const subject = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'external-maker',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const basis = {
  effectivePeriod: {},
  evidenceRefs: ['owner-record'],
  reason: 'Documented manufacturer',
  relationId: '33333333-3333-4333-8333-333333333333',
  subject,
  target: { kind: 'PARTY', partyRef },
} as const;
const captureTransport = (key: string) => ({ correlationId: key, idempotencyKey: key });
const setPayload = Schema.decodeUnknownSync(SetProductManufacturerPayloadSchema)(basis);
const changePayload = Schema.decodeUnknownSync(ChangeProductManufacturerPayloadSchema)({
  ...basis,
  expectedRevision: 1,
});
const removePayload = Schema.decodeUnknownSync(RemoveProductManufacturerPayloadSchema)({
  evidenceRefs: basis.evidenceRefs,
  expectedRevision: 1,
  reason: basis.reason,
  relationId: basis.relationId,
  subject,
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:manufacturer-actions:run:1',
    authMethod: 'system',
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId,
  }),
  correlationId: 'manufacturer-action-test',
};
const unavailable = () =>
  Effect.fail(
    new ManufacturerPersistenceUnavailable({
      code: 'manufacturer_persistence_unavailable',
      reason: 'Owner unavailable',
    }),
  );
const context = (
  overrides: Partial<ManufacturerPersistence> = {},
): ActionHandlerContext<Readonly<Record<string, never>>, ManufacturerPersistence> => ({
  actionInvocationId: '88888888-8888-4888-8888-888888888888',
  addDomainEvent: () => Effect.succeed(Object.create(null)),
  addOutboxMessage: () => Effect.void,
  recordAuditEvidence: () => Effect.void,
  recordDataAccess: () => Effect.void,
  scope,
  services: {
    change: unavailable,
    history: () => Effect.die('Unexpected history read'),
    remove: unavailable,
    set: unavailable,
    ...overrides,
  },
});

describe('manufacturer Action contracts', () => {
  it.effect('rolls back every manufacturer Action when decoded-success capture fails', () =>
    Effect.gen(function* manufacturerCaptureFailure() {
      const applied = {
        _tag: 'applied' as const,
        relationId: setPayload.relationId,
        revision: 1,
      };
      const captured: string[] = [];
      const services = {
        captureResult: (actionInvocationId: string) =>
          Effect.gen(function* failCapture() {
            captured.push(actionInvocationId);
            return yield* new ActionTransactionError({
              code: 'action_transaction_failed',
              reason: 'Catalog result capture failed',
            });
          }),
        change: () => Effect.succeed(applied),
        history: () => Effect.die('Unexpected history read'),
        remove: () => Effect.succeed(applied),
        set: () => Effect.succeed(applied),
      };
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(setProductManufacturerAction, services),
          bindActionTestServices(changeProductManufacturerAction, services),
          bindActionTestServices(removeProductManufacturerAction, services),
        ],
      });
      const principal = {
        authBindingId: '99999999-9999-4999-8999-999999999999',
        authContextRef: 'better-auth-session:manufacturer-result-capture',
        authMethod: 'session' as const,
        principalId: scope.principalId,
        tenantId,
      };
      const failures = yield* Effect.all(
        [
          harness.runtime
            .runAction({
              payload: setPayload,
              principal,
              registration: setProductManufacturerAction,
              transport: captureTransport('manufacturer-set-capture'),
            })
            .pipe(Effect.flip),
          harness.runtime
            .runAction({
              payload: changePayload,
              principal,
              registration: changeProductManufacturerAction,
              transport: captureTransport('manufacturer-change-capture'),
            })
            .pipe(Effect.flip),
          harness.runtime
            .runAction({
              payload: removePayload,
              principal,
              registration: removeProductManufacturerAction,
              transport: captureTransport('manufacturer-remove-capture'),
            })
            .pipe(Effect.flip),
        ],
        { concurrency: 1 },
      ).pipe(Effect.provideService(ReadRuntime, { runRead: () => Effect.die('Unexpected governed read') }));
      for (const failure of failures) {
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
      expect(captured).toHaveLength(3);
      expect(harness.snapshot().committed).toHaveLength(0);
    }),
  );
  it('requires typed identity, exact subject, reason and evidence', () => {
    const decode = Schema.decodeUnknownSync(SetProductManufacturerPayloadSchema);
    expect(decode(basis).target).toEqual(basis.target);
    expect(() => decode({ ...basis, evidenceRefs: [] })).toThrow();
    expect(() => decode({ ...basis, reason: ' ' })).toThrow();
    expect(() => decode({ ...basis, target: { kind: 'PARTY', name: 'Maker' } })).toThrow();
    expect(() => decode({ ...basis, subject: { ...subject, resourceType: 'commerce.catalog.unknown' } })).toThrow();
    expect(() =>
      decode({
        ...basis,
        target: { kind: 'PARTY', partyRef: { ...partyRef, tenantId: '99999999-9999-4999-8999-999999999999' } },
      }),
    ).toThrow();
  });

  it('requires optimistic revision for change and removal', () => {
    const change = Schema.decodeUnknownSync(ChangeProductManufacturerPayloadSchema);
    const remove = Schema.decodeUnknownSync(RemoveProductManufacturerPayloadSchema);
    expect(change({ ...basis, expectedRevision: 1 }).expectedRevision).toBe(1);
    expect(
      remove({
        evidenceRefs: ['owner-record'],
        expectedRevision: 1,
        reason: 'Retracted',
        relationId: basis.relationId,
        subject,
      }).expectedRevision,
    ).toBe(1);
    expect(() => change({ ...basis, expectedRevision: 0 })).toThrow();
    expect(() => remove({ ...basis, expectedRevision: -1 })).toThrow();
  });

  it.effect('preserves definite owner forbidden separately from unavailable', () =>
    Effect.gen(function* verifyForbidden() {
      expect(setProductManufacturerAction.descriptor.idempotency).toBe('required');
      const forbidden = yield* handleSetProductManufacturer(
        setPayload,
        context({
          set: () => Effect.fail(new ManufacturerTargetForbidden()),
        }),
      ).pipe(Effect.flip);
      expect(Schema.is(ManufacturerTargetForbidden)(forbidden)).toBe(true);
      const failed = yield* handleSetProductManufacturer(setPayload, context()).pipe(Effect.flip);
      expect(Schema.is(ManufacturerPersistenceUnavailable)(failed)).toBe(true);
    }),
  );

  it.effect('maps missing, invalid, and conflicting mutations without writing evidence', () =>
    Effect.gen(function* verifyOutcomes() {
      const missing = yield* handleSetProductManufacturer(
        setPayload,
        context({ set: () => Effect.succeed({ _tag: 'not_found' }) }),
      ).pipe(Effect.flip);
      expect(missing).toMatchObject({ code: 'manufacturer_not_found' });
      const conflict = yield* handleChangeProductManufacturer(
        changePayload,
        context({ change: () => Effect.succeed({ _tag: 'identity_conflict' }) }),
      ).pipe(Effect.flip);
      expect(conflict).toMatchObject({ code: 'manufacturer_conflict' });
      const removed = yield* handleRemoveProductManufacturer(
        removePayload,
        context({
          remove: () => Effect.succeed({ _tag: 'applied', relationId: removePayload.relationId, revision: 2 }),
        }),
      );
      expect(removed).toMatchObject({ revision: 2, subject });
    }),
  );
});
