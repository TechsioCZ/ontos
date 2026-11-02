import { performance } from 'node:perf_hooks';
import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Effect, Option, Predicate, flow } from 'effect';

import { SpiceDbConfigError } from './config-error.ts';
import type { SpiceDbConfigValue } from './config.ts';
import { SpiceDbRpcError, spiceDbDeadline } from './spicedb-rpc.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';
import { observeFirstSpiceDbRpc } from './spicedb-client-observability.ts';

/**
 * The gRPC channel's only trusted CA: `SPICEDB_CA_CERT`, the certificate SpiceDB serves on its
 * gRPC port. There is no plaintext or system-trust mode.
 */
export const spiceDbCaCertificate = (configuration: Pick<SpiceDbConfigValue, 'caCertificate'>): Buffer => {
  if (configuration.caCertificate === undefined) {
    throw new SpiceDbConfigError({ reason: 'SPICEDB_CA_CERT is required for the SpiceDB gRPC client' });
  }
  return Buffer.from(configuration.caCertificate);
};

/** An authzed-node gRPC client that trusts only `SPICEDB_CA_CERT`. Every Node caller opens SpiceDB through it. */
export const newSpiceDbGrpcClient = (
  configuration: Pick<SpiceDbConfigValue, 'caCertificate' | 'endpoint' | 'preSharedKey'>,
  options?: Parameters<typeof v1.NewClientWithCustomCert>[4],
): v1.ZedClientInterface => {
  const started = performance.now();
  let outcome: 'success' | 'failure' = 'failure';
  try {
    const client = v1.NewClientWithCustomCert(
      configuration.preSharedKey,
      configuration.endpoint,
      spiceDbCaCertificate(configuration),
      undefined,
      options,
    );
    outcome = 'success';
    return client;
  } finally {
    globalThis.ontosSpiceDbClientObserver?.({
      durationMs: performance.now() - started,
      event: 'spicedb.channel-setup',
      method: 'NewClientWithCustomCert',
      outcome,
    });
  }
};

const rpcFailure = (cause: unknown): SpiceDbRpcError =>
  new SpiceDbRpcError({
    cause,
    code:
      Predicate.hasProperty(cause, 'code') && Predicate.isNumber(cause.code) ? Option.some(cause.code) : Option.none(),
  });

/** SpiceDB over gRPC through the official authzed-node client (HTTP/2, Node only). */
export const openSpiceDbGrpcRpc = (configuration: SpiceDbConfigValue, timeoutMilliseconds: number): SpiceDbRpc => {
  const client = newSpiceDbGrpcClient(configuration, { interceptors: [deadlineInterceptor(timeoutMilliseconds)] });
  const deadline = spiceDbDeadline(timeoutMilliseconds);
  const { promises } = client;
  return {
    checkBulkPermissions: (request) =>
      Effect.tryPromise({
        catch: rpcFailure,
        try: flow(() => request, promises.checkBulkPermissions.bind(promises)),
      }).pipe(Effect.timeoutOrElse(deadline), observeFirstSpiceDbRpc('checkBulkPermissions')),
    checkPermission: (request) =>
      Effect.tryPromise({
        catch: rpcFailure,
        try: flow(() => request, promises.checkPermission.bind(promises)),
      }).pipe(Effect.timeoutOrElse(deadline), observeFirstSpiceDbRpc('checkPermission')),
    close: () => client.close(),
    diffSchema: (request) =>
      Effect.tryPromise({
        catch: rpcFailure,
        try: flow(() => request, promises.diffSchema.bind(promises)),
      }).pipe(Effect.timeoutOrElse(deadline), observeFirstSpiceDbRpc('diffSchema')),
    readRelationships: (request) =>
      Effect.tryPromise({
        catch: rpcFailure,
        try: flow(() => request, promises.readRelationships.bind(promises)),
      }).pipe(Effect.timeoutOrElse(deadline), observeFirstSpiceDbRpc('readRelationships')),
    readSchema: (request) =>
      Effect.tryPromise({
        catch: rpcFailure,
        try: flow(() => request, promises.readSchema.bind(promises)),
      }).pipe(Effect.timeoutOrElse(deadline), observeFirstSpiceDbRpc('readSchema')),
    writeRelationships: (request) =>
      Effect.tryPromise({
        catch: rpcFailure,
        try: flow(() => request, promises.writeRelationships.bind(promises)),
      }).pipe(Effect.timeoutOrElse(deadline), observeFirstSpiceDbRpc('writeRelationships')),
    writeSchema: (request) =>
      Effect.tryPromise({
        catch: rpcFailure,
        try: flow(() => request, promises.writeSchema.bind(promises)),
      }).pipe(Effect.timeoutOrElse(deadline), observeFirstSpiceDbRpc('writeSchema')),
  };
};
