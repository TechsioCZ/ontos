import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  SetCompositionCurrentRequestSchema,
  SetCompositionCurrentResponseSchema,
} from '../../shared/apis/set-composition-current.ts';
import {
  SetCompositionHistoryRequestSchema,
  SetCompositionHistoryResponseSchema,
} from '../../shared/apis/set-composition-history.ts';
import { SetCompositionRevisionSchema } from '../../shared/domain/set-composition.ts';
import { readSetCompositionCurrent, setCompositionCurrentRead } from '../../src/api/set-composition-current.read.ts';
import { readSetCompositionHistory, setCompositionHistoryRead } from '../../src/api/set-composition-history.read.ts';
import { SetCompositionPersistenceUnavailable } from '../../src/persistence/set-composition-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '99999999-9999-4999-8999-999999999999';
const compositionId = '44444444-4444-4444-8444-444444444444';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${resourceType}`,
  tenantId,
});
const revision = (number: number, variantId: string) =>
  Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
    components: [
      {
        componentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        quantity: { amount: '2', unitRef: ref('product-unit', '77777777-7777-4777-8777-777777777777') },
        selection: {
          productRef: ref('product', '88888888-8888-4888-8888-888888888888'),
          variantRef: ref('variant', variantId),
        },
      },
      {
        componentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        quantity: { amount: '3', unitRef: ref('product-unit', '77777777-7777-4777-8777-777777777777') },
        selection: {
          productRef: ref('product', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
          variantRef: ref('variant', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
        },
      },
    ],
    productRef: ref('product', '22222222-2222-4222-8222-222222222222'),
    provenance: {
      changeKind: number > 1 ? 'MATERIAL_CHANGE' : 'INITIAL',
      evidenceRefs: [`evidence:r${number}`],
      reason: `Evidence R${number}`,
    },
    reference: { resourceRef: ref('set-composition', compositionId), revision: number },
    variantRef: ref('variant', '33333333-3333-4333-8333-333333333333'),
  });
const r1 = {
  effectiveFrom: new Date('2026-09-17T00:00:00.000Z'),
  lifecycleState: 'ACTIVE' as const,
  revision: revision(1, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
};
const r2 = {
  effectiveFrom: new Date('2026-09-18T00:00:00.000Z'),
  lifecycleState: 'ACTIVE' as const,
  revision: revision(2, 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
};
const currentRequest = Schema.decodeUnknownSync(SetCompositionCurrentRequestSchema)({
  resourceRef: ref('set-composition', compositionId),
});
const historyRequest = Schema.decodeUnknownSync(SetCompositionHistoryRequestSchema)({
  reference: r1.revision.reference,
});
const services = (current = Option.some(r2), historical = Option.some(r1)) => ({
  readCurrent: () => Effect.succeed(current),
  readRevision: () => Effect.succeed(historical),
});

describe('governed Set composition reads', () => {
  it.effect('keeps historical R1 exact after Current advances to R2', () =>
    Effect.gen(function* exactHistoricalRevision() {
      const source = services();
      const current = yield* readSetCompositionCurrent(currentRequest, tenantId, source);
      const history = yield* readSetCompositionHistory(historyRequest, tenantId, source);
      expect(current.result.revision.reference.revision).toBe(2);
      expect(history.result.revision.reference.revision).toBe(1);
      expect(history.result.historical).toBe(true);
      expect(
        history.result.revision.components.map(
          (component: (typeof r1.revision.components)[number]) => component.componentId,
        ),
      ).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
      expect(history.result.revision.components[1]?.selection.variantRef.resourceId).toBe(
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      );
      expect(history.result.revision.components[1]?.quantity.amount).toBe('2');
      expect(history.result.revision.provenance.evidenceRefs).toEqual(['evidence:r1']);
      expect(history.result.effectiveFrom).toBe('2026-09-17T00:00:00.000Z');
      expect(() => Schema.encodeSync(SetCompositionCurrentResponseSchema)(current.result)).not.toThrow();
      expect(() => Schema.encodeSync(SetCompositionHistoryResponseSchema)(history.result)).not.toThrow();
    }),
  );

  it.effect('makes foreign and missing revisions indistinguishable without calling storage for foreign Tenant', () =>
    Effect.gen(function* absentOrForeignRevision() {
      let reads = 0;
      const source = {
        readRevision: () => {
          reads += 1;
          return Effect.succeed(Option.none());
        },
      };
      const foreign = yield* readSetCompositionHistory(historyRequest, foreignTenantId, source).pipe(Effect.flip);
      expect(reads).toBe(0);
      const missing = yield* readSetCompositionHistory(historyRequest, tenantId, source).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(foreign)).toBe(true);
      expect(Schema.is(ReadHandlerNotFound)(missing)).toBe(true);
      expect(foreign.reason).toBe(missing.reason);
    }),
  );

  it.effect('returns typed unavailable without leaking persistence detail', () =>
    Effect.gen(function* unavailableRevision() {
      const source = {
        readCurrent: () =>
          Effect.fail(
            new SetCompositionPersistenceUnavailable({
              code: 'set_composition_persistence_unavailable',
              reason: 'private database detail',
            }),
          ),
      };
      const failure = yield* readSetCompositionCurrent(currentRequest, tenantId, source).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('private database detail');
    }),
  );
});

it('rejects fabricated revision IDs and guards both endpoints with tenant read permission', () => {
  expect(() =>
    Schema.decodeUnknownSync(SetCompositionHistoryRequestSchema)({
      reference: { ...historyRequest.reference, revisionId: compositionId },
    }),
  ).toThrow();
  for (const read of [setCompositionCurrentRead, setCompositionHistoryRead]) {
    expect(read.descriptor.entrypoint.authorization.kind).toBe('context_permission');
    expect(read.descriptor.legalEntityScope).toBe('forbidden');
    expect(read.descriptor.permissionTarget).toBe('tenant');
  }
  expect(setCompositionHistoryRead.descriptor.entrypoint.access).toBe('historical_read');
});
