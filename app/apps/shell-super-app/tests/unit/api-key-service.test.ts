import { expect, test } from '@rstest/core';
import { APIError } from 'better-auth';
import { eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import {
  ApiKeyProviderUnavailableError,
  makeApiKeyService,
} from '../../api/auth/api-key-service.ts';
import { apikey } from '../../api/auth/db/schema.ts';
import type { AuthDatabaseExecutor } from '../../api/auth/db/types.ts';

const configuration = {
  baseUrl: 'http://localhost:3020',
  connectionString: 'postgres://unused:unused@localhost/unused',
  secret: 'unit-test-secret-not-used-for-real-authentication',
  secureCookies: false,
  supportUserIds: [],
  trustedOrigins: ['http://localhost:3020'],
};
const record = {
  createdAt: new Date('2026-08-09T00:00:00.000Z'),
  enabled: true,
  expiresAt: new Date('2027-08-09T00:00:00.000Z'),
  id: 'provider-key-id',
  key: 'must-not-leak',
  metadata: 'must-not-leak',
  name: 'automation',
  start: 'onto',
};

const makeService = (query: () => Promise<readonly (typeof record)[]>) => {
  const calls: { operation: string; value: unknown }[] = [];
  const builder = {
    returning: (value: unknown) => {
      calls.push({ operation: 'returning', value });
      return query();
    },
    set: (value: unknown) => {
      calls.push({ operation: 'set', value });
      return builder;
    },
    where: (value: unknown) => {
      calls.push({ operation: 'where', value });
      return builder;
    },
  };
  // Only the update chain used by setEnabled is implemented; no database connection is opened.
  const database = {
    update: (value: unknown) => {
      calls.push({ operation: 'update', value });
      return builder;
    },
  } as unknown as AuthDatabaseExecutor;
  return { calls, service: makeApiKeyService(configuration, database) };
};

test('missing returned key preserves the provider-unavailable classification without throwing', async () => {
  const { calls, service } = makeService(() => Promise.resolve([]));
  const operation = service.setEnabled(record.id, false);
  expect(calls).toEqual([]);
  const failure = await Effect.runPromise(Effect.flip(operation));
  expect(failure).toBeInstanceOf(ApiKeyProviderUnavailableError);
  expect(failure.code).toBe('api_key_provider_unavailable');
  expect(failure.reason).toBe('The credential provider is temporarily unavailable');
  expect(calls.map(({ operation: name }) => name)).toEqual(['update', 'set', 'where', 'returning']);
});

test.each([true, false])(
  'setEnabled(%s) preserves query order and returns only safe metadata',
  async (enabled) => {
    const { calls, service } = makeService(() => Promise.resolve([{ ...record, enabled }]));
    const result = await Effect.runPromise(service.setEnabled(record.id, enabled));
    expect(calls).toEqual([
      { operation: 'update', value: apikey },
      { operation: 'set', value: { enabled, updatedAt: expect.any(Date) } },
      { operation: 'where', value: eq(apikey.id, record.id) },
      {
        operation: 'returning',
        value: {
          createdAt: apikey.createdAt,
          enabled: apikey.enabled,
          expiresAt: apikey.expiresAt,
          id: apikey.id,
          name: apikey.name,
          start: apikey.start,
        },
      },
    ]);
    expect(result).toEqual({
      createdAt: record.createdAt.toISOString(),
      enabled,
      expiresAt: record.expiresAt.toISOString(),
      name: record.name,
      providerKeyId: record.id,
      start: record.start,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  },
);

test.each([
  new Error('secret database details'),
  new APIError('TOO_MANY_REQUESTS', { message: 'secret database details' }),
  new APIError('BAD_REQUEST', { message: 'secret database details' }),
])(
  'query rejection remains provider-unavailable without exposing provider details',
  async (cause) => {
    const { service } = makeService(() => Promise.reject(cause));
    const failure = await Effect.runPromise(Effect.flip(service.setEnabled(record.id, false)));
    expect(failure).toBeInstanceOf(ApiKeyProviderUnavailableError);
    const wire = Schema.encodeSync(ApiKeyProviderUnavailableError)(
      failure as ApiKeyProviderUnavailableError,
    );
    expect(wire).toEqual({
      _tag: 'ApiKeyProviderUnavailableError',
      code: 'api_key_provider_unavailable',
      reason: 'The credential provider is temporarily unavailable',
    });
    expect(JSON.stringify(failure)).not.toContain('secret database details');
  },
);
