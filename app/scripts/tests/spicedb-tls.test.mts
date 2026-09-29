import { X509Certificate } from 'node:crypto';

import { DateTime, Effect, Layer, Option, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { CloudflareApiLive, CloudflareCredentials } from '../ops/cloudflare-api.mts';
import {
  SPICEDB_GRPC_TLS,
  SPICEDB_HTTP_TLS,
  ensureSpicedbTls,
  spicedbTlsState,
  tlsMaterialProblem,
} from '../ops/spicedb-tls.mts';
import { OpsMode } from '../ops/stage-operations.mts';
import {
  fakeCloudflareAccount,
  fakeFiles,
  fakeStage,
  fakeZeropsApi,
  spicedbTlsSecrets,
} from './stage-operations-fixture.mts';
import type { FakeCloudflareAccount, FakeStage, FakeZeropsApi } from './stage-operations-fixture.mts';

const PROJECT_ID = 'project-1';
const GATEWAY_HOSTNAME = 'ontos-stage-spicedb.stage.example.com';
const TARGET = { gatewayHostname: GATEWAY_HOSTNAME, projectId: PROJECT_ID };
const SPICEDB_SERVICE = { hostname: 'spicedb', id: 'spicedb-id', status: 'ACTIVE' };
const GRPC_CERTIFICATE = `spicedb_${SPICEDB_GRPC_TLS.certificateKey}`;
const GRPC_PRIVATE_KEY = `spicedb_${SPICEDB_GRPC_TLS.privateKeyKey}`;
const HTTP_CERTIFICATE = `spicedb_${SPICEDB_HTTP_TLS.certificateKey}`;
const HTTP_PRIVATE_KEY = `spicedb_${SPICEDB_HTTP_TLS.privateKeyKey}`;
const REPAIR = 'from the Zerops spicedb service secrets, then run spicedb-tls to create both again';

interface Fakes {
  readonly account: FakeCloudflareAccount;
  readonly stage: FakeStage;
  readonly zerops: FakeZeropsApi;
}

const newFakes = (projectValues: Readonly<Record<string, string>> = {}): Fakes => {
  const stage = fakeStage({ projectUserKeys: Object.keys(projectValues), projectValues, services: [SPICEDB_SERVICE] });
  return { account: fakeCloudflareAccount({}), stage, zerops: fakeZeropsApi(stage) };
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, fakes: Fakes, dryRun = false) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudflareApiLive.pipe(
          Layer.provide(
            Layer.succeed(CloudflareCredentials, { accountId: 'account-1', apiToken: Redacted.make('api-token') }),
          ),
          Layer.provide(fakes.account.layer),
        ),
        Layer.succeed(OpsMode, { dryRun }),
        fakes.stage.layer,
        fakes.zerops.layer,
        fakeFiles().layer,
      ),
    ),
  );

const storedValue = (fakes: Fakes, key: string) => fakes.stage.projectValues.get(key) ?? '';

it.effect('creates both pairs on the spicedb service and keeps them on a re-run', () =>
  Effect.gen(function* createsBothPairs() {
    const fakes = newFakes();

    yield* run(ensureSpicedbTls(TARGET), fakes);

    expect(fakes.zerops.serviceSecrets.map(({ key, serviceId }) => `${serviceId} ${key}`)).toStrictEqual([
      'spicedb-id SPICEDB_GRPC_TLS_KEY',
      'spicedb-id SPICEDB_GRPC_TLS_CERT',
      'spicedb-id SPICEDB_HTTP_TLS_KEY',
      'spicedb-id SPICEDB_HTTP_TLS_CERT',
    ]);
    const grpc = new X509Certificate(storedValue(fakes, GRPC_CERTIFICATE));
    expect(grpc.subjectAltName).toBe('DNS:spicedb, DNS:localhost, IP Address:127.0.0.1');
    expect(grpc.ca).toBe(false);
    const gateway = new X509Certificate(storedValue(fakes, HTTP_CERTIFICATE));
    expect(gateway.subjectAltName).toBe(`DNS:${GATEWAY_HOSTNAME}`);
    expect(gateway.issuer).toContain('Fake Origin CA');

    // Private keys travel only in memory: never in a command line or a Cloudflare request URL.
    const visible = [
      ...fakes.stage.commands.map(({ args, command }) => [command, ...args].join(' ')),
      ...fakes.account.requests.map(({ url }) => url.href),
    ].join('\n');
    expect(visible).not.toContain('PRIVATE KEY');
    expect(fakes.account.requests.map(({ method, url }) => `${method} ${url.pathname}`)).toStrictEqual([
      'POST /client/v4/certificates',
    ]);
    expect(yield* run(spicedbTlsState(TARGET), fakes)).toStrictEqual(Option.none());

    yield* run(ensureSpicedbTls(TARGET), fakes);

    expect(fakes.zerops.serviceSecrets).toHaveLength(4);
    expect(fakes.account.requests).toHaveLength(1);
  }),
);

it.effect('keeps valid stored pairs without generating anything', () =>
  Effect.gen(function* keepsValidPairs() {
    const fakes = newFakes(spicedbTlsSecrets({ gatewayHostname: GATEWAY_HOSTNAME }));

    yield* run(ensureSpicedbTls(TARGET), fakes);

    expect(fakes.stage.commands.filter(({ command }) => command === 'openssl')).toStrictEqual([]);
    expect(fakes.zerops.serviceSecrets).toStrictEqual([]);
    expect(fakes.account.requests).toStrictEqual([]);
  }),
);

it.effect('reports each mutation in a dry run and changes nothing', () =>
  Effect.gen(function* dryRunChangesNothing() {
    const fakes = newFakes();

    yield* run(ensureSpicedbTls(TARGET), fakes, true);

    expect(fakes.stage.commands.map(({ command }) => command)).toStrictEqual(['zcli']);
    expect(fakes.zerops.serviceSecrets).toStrictEqual([]);
    expect(fakes.account.requests).toStrictEqual([]);
  }),
);

it.effect('refuses a partial pair instead of rotating it', () =>
  Effect.gen(function* refusesPartialPair() {
    const { [GRPC_CERTIFICATE]: _certificate, ...withoutGrpcCertificate } = spicedbTlsSecrets({
      gatewayHostname: GATEWAY_HOSTNAME,
    });
    const fakes = newFakes(withoutGrpcCertificate);

    const error = yield* run(ensureSpicedbTls(TARGET), fakes).pipe(Effect.flip);

    expect(error.message).toBe(
      `the spicedb gRPC TLS secrets SPICEDB_GRPC_TLS_CERT and SPICEDB_GRPC_TLS_KEY: only SPICEDB_GRPC_TLS_KEY exists; remove SPICEDB_GRPC_TLS_CERT and SPICEDB_GRPC_TLS_KEY ${REPAIR}`,
    );
    expect(fakes.zerops.serviceSecrets).toStrictEqual([]);
  }),
);

it.effect('refuses a gRPC certificate that does not cover localhost', () =>
  Effect.gen(function* refusesUncoveredName() {
    const fakes = newFakes(spicedbTlsSecrets({ gatewayHostname: GATEWAY_HOSTNAME, grpcNames: ['spicedb'] }));

    const error = yield* run(ensureSpicedbTls(TARGET), fakes).pipe(Effect.flip);

    expect(error.message).toContain('SPICEDB_GRPC_TLS_KEY: it does not cover localhost; remove');
    expect(fakes.zerops.serviceSecrets).toStrictEqual([]);
  }),
);

it.live('fails verification on a gateway certificate that expires within 30 days', () =>
  Effect.gen(function* refusesExpiringCertificate() {
    const fakes = newFakes(spicedbTlsSecrets({ gatewayDays: 10, gatewayHostname: GATEWAY_HOSTNAME }));

    const state = yield* run(spicedbTlsState(TARGET), fakes);

    expect(Option.getOrElse(state, () => '')).toMatch(
      /^the spicedb HTTP gateway TLS secrets SPICEDB_HTTP_TLS_CERT and SPICEDB_HTTP_TLS_KEY: the certificate expires \d{4}-/u,
    );
  }),
);

it('refuses a key that does not belong to the certificate, and a self-issued gateway certificate', () => {
  const secrets = spicedbTlsSecrets({ gatewayHostname: GATEWAY_HOSTNAME });
  const now = DateTime.makeUnsafe('2026-01-01T00:00:00Z');
  const gateway = { names: [GATEWAY_HOSTNAME], signedByAnotherCa: true };

  expect(
    tlsMaterialProblem(
      { certificate: secrets[HTTP_CERTIFICATE] ?? '', privateKey: Redacted.make(secrets[GRPC_PRIVATE_KEY] ?? '') },
      gateway,
      now,
    ),
  ).toStrictEqual(Option.some('the private key does not belong to the certificate'));
  expect(
    tlsMaterialProblem(
      { certificate: secrets[GRPC_CERTIFICATE] ?? '', privateKey: Redacted.make(secrets[GRPC_PRIVATE_KEY] ?? '') },
      { names: ['spicedb'], signedByAnotherCa: true },
      now,
    ),
  ).toStrictEqual(Option.some('the certificate is self-issued, not signed by the Cloudflare Origin CA'));
  expect(
    tlsMaterialProblem(
      { certificate: secrets[HTTP_CERTIFICATE] ?? '', privateKey: Redacted.make(secrets[HTTP_PRIVATE_KEY] ?? '') },
      gateway,
      now,
    ),
  ).toStrictEqual(Option.none());
  expect(
    tlsMaterialProblem({ certificate: 'not a certificate', privateKey: Redacted.make('') }, gateway, now),
  ).toStrictEqual(Option.some('the certificate is not a PEM X.509 certificate'));
});
