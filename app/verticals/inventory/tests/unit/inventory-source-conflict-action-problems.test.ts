import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import { mapResolveInventorySourceConflictActionProblem } from '../../api/resolve-inventory-source-conflict-action-problems.ts';
import {
  ResolveInventorySourceConflictActionConflictProblemSchema,
  ResolveInventorySourceConflictActionNotFoundProblemSchema,
  ResolveInventorySourceConflictActionUnavailableProblemSchema,
} from '../../shared/apis/resolve-inventory-source-conflict-action.ts';
import { InventorySourceConflictNotFound } from '../../shared/domain/inventory-source-conflict-not-found.ts';
import { InventorySourceConflictRejected } from '../../shared/domain/inventory-source-conflict-rejected.ts';
import { InventorySourceConflictUnavailable } from '../../shared/domain/inventory-source-conflict-unavailable.ts';
import { InventorySourceConflictResolutionInputSchema } from '../../shared/domain/inventory-source-conflict.ts';
import { InventorySourceConflictRefSchema } from '../../shared/resources/inventory-source-conflict.ts';
import { makeInventorySourceConflictService } from '../../src/services/inventory-source-conflict.service.ts';

const conflictRef = Schema.decodeUnknownSync(InventorySourceConflictRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: '11111111-1111-4111-8111-111111111111',
  resourceType: 'commerce.inventory.inventory-source-conflict',
  tenantId: '22222222-2222-4222-8222-222222222222',
});

it('maps missing, rejected, and unavailable conflict resolution failures to typed 404, 409, and 503 problems', () => {
  const missing = mapResolveInventorySourceConflictActionProblem(
    new InventorySourceConflictNotFound({
      code: 'inventory_source_conflict_not_found',
      conflictRef,
    }),
  );
  const rejected = mapResolveInventorySourceConflictActionProblem(
    new InventorySourceConflictRejected({
      code: 'inventory_source_conflict_rejected',
      conflictRef,
      reason: 'ALREADY_RESOLVED',
    }),
  );
  const unavailable = mapResolveInventorySourceConflictActionProblem(
    new InventorySourceConflictUnavailable({
      code: 'inventory_source_conflict_unavailable',
      reason: 'private storage diagnostic',
      retryable: true,
    }),
  );

  expect(missing).toMatchObject({ code: 'inventory_source_conflict_not_found', status: 404 });
  expect(rejected).toMatchObject({ code: 'inventory_source_conflict_rejected', status: 409 });
  expect(unavailable).toMatchObject({
    code: 'inventory_source_conflict_unavailable',
    retryable: true,
    status: 503,
  });
  expect(Schema.is(ResolveInventorySourceConflictActionNotFoundProblemSchema)(missing)).toBe(true);
  expect(Schema.is(ResolveInventorySourceConflictActionConflictProblemSchema)(rejected)).toBe(true);
  expect(Schema.is(ResolveInventorySourceConflictActionUnavailableProblemSchema)(unavailable)).toBe(true);
  expect(JSON.stringify([missing, rejected, unavailable])).not.toContain(conflictRef.resourceId);
  expect(JSON.stringify([missing, rejected, unavailable])).not.toContain('private storage diagnostic');
});

it.effect('returns the typed not-found failure when the requested conflict does not exist', () =>
  Effect.gen(function* test() {
    const service = makeInventorySourceConflictService({
      assertions: { findById: () => Effect.die('must not read assertions') },
      backendConfigurations: { findCurrent: () => Effect.die('must not read backend configuration') },
      conflicts: {
        appendOpen: () => Effect.die('must not append an open conflict'),
        appendResolution: () => Effect.die('must not append a resolution'),
        findLatest: () => Effect.succeedNone,
      },
      positions: {
        read: () => Effect.die('must not read a Position'),
        save: () => Effect.die('must not save a Position'),
      },
    });
    const input = Schema.decodeUnknownSync(InventorySourceConflictResolutionInputSchema)({
      conflictRef,
      expectedRevision: 1,
      ownerEvidenceRef: 'owner-resolution-missing',
      resolution: {
        _tag: 'CURRENT_ASSERTION',
        assertionId: '33333333-3333-4333-8333-333333333333',
      },
      resolvedAt: '2026-09-24T19:00:00.000Z',
    });

    const failure = yield* Effect.flip(
      service.resolve(input, {
        principalId: 'principal-a',
        tenantId: conflictRef.tenantId,
      }),
    );

    expect(failure).toBeInstanceOf(InventorySourceConflictNotFound);
    expect(failure).toMatchObject({ code: 'inventory_source_conflict_not_found', conflictRef });
    expect(mapResolveInventorySourceConflictActionProblem(failure)).toMatchObject({
      code: 'inventory_source_conflict_not_found',
      status: 404,
    });
  }),
);
