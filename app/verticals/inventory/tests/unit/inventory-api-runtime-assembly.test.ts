import { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import {
  OWNER_ACTION_APPROVAL_INSPECTION_PATH,
  OWNER_ACTION_APPROVAL_PATH,
  OwnerActionApprovalInvalidSchema,
} from '@app/core-runtime/access/approvals/owner-api';
import { OwnerActionApprovals } from '@app/core-runtime/access/approvals/owner-runtime';
import { Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ProvisionSourceStockItemActionInvalidProblemSchema } from '../../shared/apis/provision-source-stock-item-action.ts';
import { makeInventoryApiRuntime } from '../../api/index.ts';

const unused = () => Effect.die('An invalid request must not invoke an owner service');

it.effect('assembles every declared Inventory HTTP group before serving readiness or invalid commands', () =>
  Effect.gen(function* inventoryHttpAssembly() {
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
      runtime.handler(
        new Request('https://inventory.test/inventory/actions/provision-source-stock-item', {
          body: '{}',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      ),
    );
    expect(invalid.status).toBe(400);
    const body = yield* Effect.promise(() => invalid.json());
    expect(Schema.is(ProvisionSourceStockItemActionInvalidProblemSchema)(body)).toBe(true);
    for (const path of [OWNER_ACTION_APPROVAL_INSPECTION_PATH, OWNER_ACTION_APPROVAL_PATH]) {
      const approval = yield* Effect.promise(() =>
        runtime.handler(
          new Request(`https://inventory.test${path}`, {
            body: '{}',
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }),
        ),
      );
      expect(approval.status).toBe(400);
      const problem = yield* Effect.promise(() => approval.json());
      expect(Schema.is(OwnerActionApprovalInvalidSchema)(problem)).toBe(true);
    }
  }).pipe(Effect.scoped),
);
