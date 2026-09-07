import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { Cause, Effect, flow, Schema } from 'effect';
import {
  SpiceDbPermissionClientError,
  createSpiceDbPermissionClient,
  SPICEDB_CHECK_TIMEOUT_MS,
} from '../../src/permissions/client.ts';

const configuration = {
  endpoint: 'localhost:50051',
  insecureLocal: true,
  preSharedKey: 'test-key',
} as const;

test(
  'permission RPCs are lazy and execute again on each Effect run',
  flow(
    (context) =>
      Effect.gen(function* checksLazyRpcExecution() {
        const check = context.mock.method(
          v1.PermissionsServiceClient.prototype,
          'checkPermission',
          (
            _request: v1.CheckPermissionRequest,
            // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Implements the Authzed SDK callback protocol; remove-when: SDK exposes native Effect.
            callback: (error: null, response: v1.CheckPermissionResponse) => void,
            // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Implements the Authzed SDK callback protocol; remove-when: SDK exposes native Effect.
          ) => callback(null, v1.CheckPermissionResponse.create({})),
        );
        const bulk = context.mock.method(
          v1.PermissionsServiceClient.prototype,
          'checkBulkPermissions',
          (
            _request: v1.CheckBulkPermissionsRequest,
            // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Implements the Authzed SDK callback protocol; remove-when: SDK exposes native Effect.
            callback: (error: null, response: v1.CheckBulkPermissionsResponse) => void,
            // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Implements the Authzed SDK callback protocol; remove-when: SDK exposes native Effect.
          ) => callback(null, v1.CheckBulkPermissionsResponse.create({})),
        );
        const client = createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS);
        context.after(() => client.close());
        const request = v1.CheckPermissionRequest.create({});
        const bulkRequest = v1.CheckBulkPermissionsRequest.create({});
        const operation = client.checkPermission(request);
        const bulkOperation = client.checkBulkPermissions(bulkRequest);
        assert.equal(check.mock.callCount(), 0);
        assert.equal(bulk.mock.callCount(), 0);
        yield* operation;
        yield* operation;
        yield* bulkOperation;
        yield* bulkOperation;
        assert.equal(check.mock.callCount(), 2);
        assert.equal(bulk.mock.callCount(), 2);
        assert.equal(check.mock.calls[0]?.arguments[0], request);
        assert.equal(bulk.mock.calls[0]?.arguments[0], bulkRequest);
      }),
    runEffectTestPromise,
  ),
);

test(
  'SDK rejections become typed permission failures without leaking diagnostics',
  flow(
    (context) =>
      Effect.gen(function* checksTypedSdkFailure() {
        const cause = new Error('private transport diagnostic');
        context.mock.method(
          v1.PermissionsServiceClient.prototype,
          'checkPermission',
          // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Implements the Authzed SDK callback protocol; remove-when: SDK exposes native Effect.
          (_request: v1.CheckPermissionRequest, callback: (error: Error) => void) =>
            // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Implements the Authzed SDK callback protocol; remove-when: SDK exposes native Effect.
            callback(cause),
        );
        const client = createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS);
        context.after(() => client.close());
        const failure = yield* Effect.flip(
          client.checkPermission(v1.CheckPermissionRequest.create({})),
        );
        assert.ok(Schema.is(SpiceDbPermissionClientError)(failure));
        assert.equal(failure.reason.includes(cause.message), false);
        assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause')?.value, cause);
      }),
    runEffectTestPromise,
  ),
);

test(
  'an SDK call that never replies is bounded by the permission deadline',
  flow(
    (context) =>
      Effect.gen(function* checksPermissionDeadline() {
        context.mock.method(v1.PermissionsServiceClient.prototype, 'checkPermission', () => {});
        const client = createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS);
        context.after(() => client.close());
        const failure = yield* Effect.flip(
          client.checkPermission(v1.CheckPermissionRequest.create({})),
        );
        assert.ok(Schema.is(SpiceDbPermissionClientError)(failure));
        assert.ok(Cause.isTimeoutError(Object.getOwnPropertyDescriptor(failure, 'cause')?.value));
      }),
    runEffectTestPromise,
  ),
);
