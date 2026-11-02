import { DateTime, Effect, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { ManufacturerTargetSchema } from '../../shared/domain/manufacturer-relation.ts';
import {
  ManufacturerTargetForbidden,
  ManufacturerTargetUnavailable,
} from '../../src/persistence/manufacturer-target-resolver.ts';
import { preparedManufacturerTargetResolver } from '../../src/services/manufacturer-target-preflight.ts';
import { setProductManufacturerAction } from '../../src/actions/set-product-manufacturer.action.ts';
import { changeProductManufacturerAction } from '../../src/actions/change-product-manufacturer.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const target = Schema.decodeUnknownSync(ManufacturerTargetSchema)({
  kind: 'LEGAL_ENTITY',
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
});
const scope = {
  authMethod: 'system' as const,
  correlationId: 'manufacturer-preflight',
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
};
const requestScope = { requestId: scope.correlationId, tenantId };

describe('Manufacturer target preflight evidence', () => {
  it.effect('preserves owner denial for the exact request and rejects cross-scope reuse and expiry', () =>
    Effect.gen(function* denialAndBinding() {
      const denied = new ManufacturerTargetForbidden();
      const resolver = preparedManufacturerTargetResolver({
        preparedAt: yield* DateTime.now,
        resolution: Result.fail(denied),
        scope,
        target,
      });
      expect(yield* resolver.resolve(target, requestScope).pipe(Effect.flip)).toBe(denied);
      expect(
        yield* resolver.resolve(target, { ...requestScope, requestId: 'other-invocation' }).pipe(Effect.flip),
      ).toBeInstanceOf(ManufacturerTargetUnavailable);
      expect(
        yield* resolver
          .resolve(target, { ...requestScope, tenantId: '44444444-4444-4444-8444-444444444444' })
          .pipe(Effect.flip),
      ).toBeInstanceOf(ManufacturerTargetUnavailable);
      const anotherTarget = Schema.decodeUnknownSync(ManufacturerTargetSchema)({
        kind: 'LEGAL_ENTITY',
        legalEntityRef: {
          moduleId: 'core.identity',
          resourceId: '55555555-5555-4555-8555-555555555555',
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      });
      expect(yield* resolver.resolve(anotherTarget, requestScope).pipe(Effect.flip)).toBeInstanceOf(
        ManufacturerTargetUnavailable,
      );
      yield* TestClock.adjust('30 seconds');
      expect(yield* resolver.resolve(target, requestScope).pipe(Effect.flip)).toBeInstanceOf(
        ManufacturerTargetUnavailable,
      );
    }),
  );

  it('registers preflight on both manufacturer owner-resolution Actions', () => {
    expect(getActionServicePreflight(setProductManufacturerAction)).toBeDefined();
    expect(getActionServicePreflight(changeProductManufacturerAction)).toBeDefined();
  });
});
