import { Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  IntegrationWorkerSettingsSchema,
  integrationWorkerEnvironment,
} from '../ci/integration-worker-environment.mts';

const decode = Schema.decodeUnknownResult(IntegrationWorkerSettingsSchema);

const environment = {
  DATABASE_ADMIN_URL: 'postgresql://admin:admin@localhost:5433/ontos_ci',
  DATABASE_URL: 'postgresql://runtime:runtime@localhost:5433/ontos_ci',
  ONTOS_CI_ISOLATED_WORKERS: '2',
  PARTY_REGISTRY_DATABASE_URL: 'postgresql://party:party@localhost:5433/ontos_ci',
  PARTY_REGISTRY_WORKER_DATABASE_URL: 'postgresql://worker:worker@localhost:5433/ontos_ci',
  SHELL_GATEWAY_ISSUER_DATABASE_URL: 'postgresql://issuer:issuer@localhost:5433/ontos_ci',
};

it('leaves ordinary local test configuration untouched', () => {
  expect(
    Result.getOrThrow(decode({}).pipe(Result.map(integrationWorkerEnvironment), Result.map(Option.getOrUndefined))),
  ).toBeUndefined();
});

it('retargets every identity and child fixture to the slot-owned cluster and datastore', () => {
  const one = Result.getOrThrow(
    decode({ ...environment, RSTEST_WORKER_ID: '1' }).pipe(
      Result.map(integrationWorkerEnvironment),
      Result.map(Option.getOrUndefined),
    ),
  );
  const two = Result.getOrThrow(
    decode({ ...environment, RSTEST_WORKER_ID: '2' }).pipe(
      Result.map(integrationWorkerEnvironment),
      Result.map(Option.getOrUndefined),
    ),
  );
  for (const key of [
    'DATABASE_ADMIN_URL',
    'DATABASE_URL',
    'PARTY_REGISTRY_DATABASE_URL',
    'PARTY_REGISTRY_WORKER_DATABASE_URL',
    'SHELL_GATEWAY_ISSUER_DATABASE_URL',
  ] as const) {
    const value = environment[key];
    const first = new URL(one?.[key] ?? '');
    const second = new URL(two?.[key] ?? '');
    const original = new URL(value);
    expect(first.port).toBe('5541');
    expect(second.port).toBe('5542');
    expect(first.username).toBe(original.username);
    expect(first.password).toBe(original.password);
    expect(first.pathname).toBe(original.pathname);
  }
  expect(one?.ONTOS_TEST_DB_CONTAINER).toBe('ontos-ci-db-1');
  expect(two?.ONTOS_TEST_DB_CONTAINER).toBe('ontos-ci-db-2');
  expect(one?.SPICEDB_ENDPOINT).not.toBe(two?.SPICEDB_ENDPOINT);
});

it('refuses a missing or unprovisioned slot instead of sharing the source cluster', () => {
  for (const worker of [undefined, '0', '3', 'invalid']) {
    expect(Result.isFailure(decode({ ...environment, RSTEST_WORKER_ID: worker }))).toBe(true);
  }
  expect(Result.isFailure(decode({ ...environment, ONTOS_CI_ISOLATED_WORKERS: '4' }))).toBe(true);
});
