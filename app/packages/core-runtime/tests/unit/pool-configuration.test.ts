import assert from 'node:assert/strict';
import test from 'node:test';

import { makeEffectTestCallback } from '@app/core-runtime/testing/effect-runtime';
import { Effect, Redacted } from 'effect';

import {
  DEFAULT_DATABASE_POOL_DEADLINES,
  configureDatabasePool,
} from '../../src/db/pool-configuration.ts';

const runtimeUrl = 'postgresql://runtime:secret@localhost:5432/ontos';

test(
  'uses acquisition and statement deadlines without opting into a lock deadline',
  makeEffectTestCallback(
    Effect.gen(function* verifyDefaults() {
      const connectionString = Redacted.make(`${runtimeUrl}?sslmode=require`);
      const configuration = yield* configureDatabasePool(connectionString);

      assert.equal(
        configuration.connectionTimeoutMillis,
        DEFAULT_DATABASE_POOL_DEADLINES.connectionTimeoutMillis
      );
      assert.equal(
        configuration.statement_timeout,
        DEFAULT_DATABASE_POOL_DEADLINES.statement_timeout
      );
      assert.equal(Object.hasOwn(configuration, 'lock_timeout'), false);
      assert.equal(
        configuration.connectionString,
        `${runtimeUrl}?sslmode=require`
      );
    })
  )
);

test(
  'includes an explicitly opted-in lock deadline',
  makeEffectTestCallback(
    Effect.gen(function* verifyLockDeadline() {
      const connectionString = Redacted.make(runtimeUrl);
      const configuration = yield* configureDatabasePool(connectionString, {
        lock_timeout: 250,
      });

      assert.equal(configuration.lock_timeout, 250);
    })
  )
);

test(
  'rejects URL deadline overrides with a typed configuration failure',
  makeEffectTestCallback(
    Effect.forEach(
      [
        'connectionTimeoutMillis=1',
        'connect_timeout=1',
        'lock_timeout=1',
        'statement_timeout=1',
        'query_timeout=1',
        'options=-c%20statement_timeout%3D1',
      ],
      (parameter) =>
        Effect.gen(function* verifyParameter() {
          const connectionString = Redacted.make(`${runtimeUrl}?${parameter}`);
          const error = yield* Effect.flip(
            configureDatabasePool(connectionString)
          );
          assert.equal(error._tag, 'DatabaseConnectionError');
          assert.equal(
            error.reason,
            'Database URL deadline parameters and startup options are unsupported; use poolDeadlines'
          );
        }),
      { concurrency: 'unbounded' }
    )
  )
);

test(
  'rejects invalid deadline values with a typed configuration failure',
  makeEffectTestCallback(
    Effect.gen(function* verifyInvalidDeadline() {
      const connectionString = Redacted.make(runtimeUrl);
      const error = yield* Effect.flip(
        configureDatabasePool(connectionString, { statement_timeout: 0 })
      );

      assert.equal(error._tag, 'DatabaseConnectionError');
      assert.equal(
        error.reason,
        'Database pool deadlines must be positive 32-bit millisecond integers'
      );
    })
  )
);
