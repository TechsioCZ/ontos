import {
  ExternalIdentityClient,
  activatePrincipalBinding,
  changePrincipalBindingStatus,
  issueExternalGatewayContext,
  readPrincipalBinding,
  reservePrincipalBinding,
  resolveExternalSubject,
} from '@app/shared-contracts/server/external-identity-client';
import type {
  ExternalIdentityClientOptions,
  ExternalIdentityClientPort,
  ExternalIdentityMutationClientOptions,
} from '@app/shared-contracts/server/external-identity-client';
import { Effect, Layer } from 'effect';

import { CommerceCoreIdentityClientConfig } from './core-identity-client-config.ts';
import type { CommerceCoreIdentityClientConfigValue } from './core-identity-client-config.ts';

/**
 * The deployed Core identity transport.
 *
 * The endpoint is a deployment input, so this adapter replaces it on every call rather than
 * forwarding whatever a caller passed: no caller can point the client at another host. The
 * credential is the one the caller selected for its Attempt's Tenant through
 * `commerceCoreIdentityClientOptions`, the only constructor of these options.
 */
const coreIdentityClientFor = (configuration: CommerceCoreIdentityClientConfigValue): ExternalIdentityClientPort => {
  const read = (options: ExternalIdentityClientOptions): ExternalIdentityClientOptions => ({
    apiKey: options.apiKey,
    baseUrl: configuration.baseUrl,
    requestCorrelation: options.requestCorrelation,
  });
  const mutate = (options: ExternalIdentityMutationClientOptions): ExternalIdentityMutationClientOptions => ({
    ...read(options),
    idempotencyKey: options.idempotencyKey,
  });
  return {
    activatePrincipalBinding: (payload, options) => activatePrincipalBinding(payload, mutate(options)),
    changePrincipalBindingStatus: (payload, options) => changePrincipalBindingStatus(payload, mutate(options)),
    issueExternalGatewayContext: (payload, options) => issueExternalGatewayContext(payload, read(options)),
    readPrincipalBinding: (payload, options) => readPrincipalBinding(payload, read(options)),
    reservePrincipalBinding: (payload, options) => reservePrincipalBinding(payload, mutate(options)),
    resolveExternalSubject: (payload, options) => resolveExternalSubject(payload, read(options)),
  };
};

export const CommerceCoreIdentityClientLive = Layer.effect(
  ExternalIdentityClient,
  Effect.gen(function* makeCommerceCoreIdentityClientLive() {
    const configuration = yield* CommerceCoreIdentityClientConfig;
    return coreIdentityClientFor(configuration);
  }),
);
