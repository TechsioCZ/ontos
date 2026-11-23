import { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import { OwnerActionApprovals } from '@app/core-runtime/access/approvals/owner-runtime';
import { Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeInventoryApiRuntime } from '../../api/index.ts';

it.effect('assembles every declared Inventory HTTP group before serving readiness or invalid commands', () =>
  Effect.gen(function* inventoryHttpAssembly() {
    const unused = () => Effect.die('An invalid request must not invoke an owner service');
    const assembled = makeInventoryApiRuntime(
      Layer.succeed(ReadRuntime, { runRead: unused }),
      Layer.mergeAll(
        Layer.succeed(ActionRuntime, {
          resolveActionCommit: unused,
          resolveActionExecution: unused,
          runAction: unused,
        }),
        Layer.succeed(OwnerActionApprovals, { approve: unused, inspect: unused }),
      ),
      Layer.succeed(GatewayAssertionRedemptionService, { consume: unused }),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => assembled.createHandler()),
      (resource) => Effect.promise(() => resource.dispose()),
    );
    const readiness = yield* Effect.promise(() =>
      runtime.handler(new Request('https://inventory.test/inventory/readiness')),
    );
    expect(readiness.status).toBe(200);
    const invalid = yield* Effect.promise(() =>
      runtime.handler(new Request('https://inventory.test/inventory/actions/provision-source-stock-item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })),
    );
    expect(invalid.status).toBe(400);
    const body = yield* Effect.promise(() => invalid.json());
    expect(body).toMatchObject({ _tag: 'ProvisionSourceStockItemActionInvalidProblem' });
  }).pipe(Effect.scoped),
);
