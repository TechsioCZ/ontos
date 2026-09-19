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

import { CommerceCoreIdentityClientConfig, commerceCoreIdentityClientOptions } from './core-identity-client-config.ts';
import type { CommerceCoreIdentityClientConfigValue } from './core-identity-client-config.ts';

/**
 * The deployed Core identity transport.
 *
 * The endpoint and the server-owned service credential are deployment inputs, so this adapter
 * replaces both on every call rather than forwarding whatever a caller passed: a caller supplies
 * only the correlation it is dispatching under — and, for a mutation, its idempotency key — and can
 * therefore neither point the client at another host nor present a credential of its own choosing.
 */
const coreIdentityClientFor = (configuration: CommerceCoreIdentityClientConfigValue): ExternalIdentityClientPort => {
  const read = (options: ExternalIdentityClientOptions): ExternalIdentityClientOptions =>
    commerceCoreIdentityClientOptions(configuration, options.requestCorrelation);
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
