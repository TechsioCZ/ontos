import {
  Effect,
  makeEffectHttpApiClient,
  runEffectRequest,
} from '@modern-js/plugin-bff/effect-client';
import {
  propertyRegistryApiContract,
  propertyRegistryEffectApi,
  propertyRegistryOperationContexts,
} from '../../shared/effect/api';
import type { OperationContext } from '../../shared/effect/api';

export { Effect, runEffectRequest };

export interface PropertyRegistryClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

export const createPropertyRegistryClient = (options: PropertyRegistryClientOptions = {}) =>
  makeEffectHttpApiClient(propertyRegistryEffectApi, {
    baseUrl: options.baseUrl ?? propertyRegistryApiContract.apiPrefix,
  });

export const listPropertyRegistry = (
  options: PropertyRegistryClientOptions & { limit?: number } = {},
) =>
  createPropertyRegistryClient({
    ...options,
    operationContext: options.operationContext ?? propertyRegistryOperationContexts.list,
  }).pipe(
    Effect.flatMap((client) => client.propertyRegistry.list({ query: { limit: options.limit } })),
  );

export const getPropertyRegistryReadiness = (options: PropertyRegistryClientOptions = {}) =>
  createPropertyRegistryClient({
    ...options,
    operationContext: options.operationContext ?? propertyRegistryOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.propertyRegistry.readiness({})));

export const getPropertyRegistry = (id: string, options: PropertyRegistryClientOptions = {}) =>
  createPropertyRegistryClient({
    ...options,
    operationContext: options.operationContext ?? propertyRegistryOperationContexts.get,
  }).pipe(Effect.flatMap((client) => client.propertyRegistry.get({ params: { id } })));

export const createPropertyRegistry = (
  title: string,
  options: PropertyRegistryClientOptions = {},
) =>
  createPropertyRegistryClient({
    ...options,
    operationContext: options.operationContext ?? propertyRegistryOperationContexts.create,
  }).pipe(Effect.flatMap((client) => client.propertyRegistry.create({ payload: { title } })));
