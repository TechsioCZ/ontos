import { v1 } from '@authzed/authzed-node';
import { Cause, Effect, Fiber, Predicate, Schema } from 'effect';
import { expect, it, rstest } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  SpiceDbPermissionClientError,
  createSpiceDbPermissionClient,
  SPICEDB_CHECK_TIMEOUT_MS,
} from '../../src/permissions/client.ts';

type PermissionRpcError = NonNullable<
  Parameters<NonNullable<Parameters<v1.PermissionsServiceClient['checkPermission']>[3]>>[0]
>;

const configuration = {
  endpoint: 'localhost:50051',
  insecureLocal: true,
  preSharedKey: 'test-key',
} as const;

it.effect('permission RPCs are lazy and execute again on each Effect run', () =>
  Effect.gen(function* checksLazyRpcExecution() {
    yield* Effect.addFinalizer(() => Effect.sync(() => rstest.restoreAllMocks()));
    const check = rstest
      .spyOn(v1.PermissionsServiceClient.prototype, 'checkPermission')
      .mockImplementation((request, metadata) => {
        if (Predicate.isFunction(metadata)) {
          metadata(null, v1.CheckPermissionResponse.create({}));
        }
        return rstest.fn<v1.PermissionsServiceClient['checkPermission']>()(request, metadata);
      });
    const bulk = rstest
      .spyOn(v1.PermissionsServiceClient.prototype, 'checkBulkPermissions')
      .mockImplementation((request, metadata) => {
        if (Predicate.isFunction(metadata)) {
          metadata(null, v1.CheckBulkPermissionsResponse.create({}));
        }
        return rstest.fn<v1.PermissionsServiceClient['checkBulkPermissions']>()(request, metadata);
      });
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS)),
      (acquiredClient) => Effect.sync(() => acquiredClient.close()),
    );
    const request = v1.CheckPermissionRequest.create({});
    const bulkRequest = v1.CheckBulkPermissionsRequest.create({});
    const operation = client.checkPermission(request);
    const bulkOperation = client.checkBulkPermissions(bulkRequest);
    expect(check.mock.calls.length).toBe(0);
    expect(bulk.mock.calls.length).toBe(0);
    yield* operation;
    yield* operation;
    yield* bulkOperation;
    yield* bulkOperation;
    expect(check.mock.calls.length).toBe(2);
    expect(bulk.mock.calls.length).toBe(2);
    expect(check.mock.calls[0]?.[0]).toBe(request);
    expect(bulk.mock.calls[0]?.[0]).toBe(bulkRequest);
  }),
);

it.effect('SDK rejections become typed permission failures without leaking diagnostics', () =>
  Effect.gen(function* checksTypedSdkFailure() {
    yield* Effect.addFinalizer(() => Effect.sync(() => rstest.restoreAllMocks()));
    const cause = Object.assign(new Error('private transport diagnostic'), {
      code: 13,
      details: 'private transport diagnostic',
      metadata: rstest.fn<() => PermissionRpcError['metadata']>()(),
    });
    rstest.spyOn(v1.PermissionsServiceClient.prototype, 'checkPermission').mockImplementation((request, metadata) => {
      if (Predicate.isFunction(metadata)) {
        metadata(cause);
      }
      return rstest.fn<v1.PermissionsServiceClient['checkPermission']>()(request, metadata);
    });
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS)),
      (acquiredClient) => Effect.sync(() => acquiredClient.close()),
    );
    const failure = yield* Effect.flip(client.checkPermission(v1.CheckPermissionRequest.create({})));
    expect(Schema.is(SpiceDbPermissionClientError)(failure)).toBe(true);
    expect(failure.reason.includes(cause.message)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(failure, 'cause')?.value).toBe(cause);
  }),
);

it.effect('an SDK call that never replies is bounded by the permission deadline', () =>
  Effect.gen(function* checksPermissionDeadline() {
    yield* Effect.addFinalizer(() => Effect.sync(() => rstest.restoreAllMocks()));
    rstest
      .spyOn(v1.PermissionsServiceClient.prototype, 'checkPermission')
      .mockImplementation((request, metadata) =>
        rstest.fn<v1.PermissionsServiceClient['checkPermission']>()(request, metadata),
      );
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS)),
      (acquiredClient) => Effect.sync(() => acquiredClient.close()),
    );
    const fiber = yield* Effect.flip(client.checkPermission(v1.CheckPermissionRequest.create({}))).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust(SPICEDB_CHECK_TIMEOUT_MS);
    const failure = yield* Fiber.join(fiber);
    expect(Schema.is(SpiceDbPermissionClientError)(failure)).toBe(true);
    expect(Cause.isTimeoutError(Object.getOwnPropertyDescriptor(failure, 'cause')?.value)).toBe(true);
  }),
);
