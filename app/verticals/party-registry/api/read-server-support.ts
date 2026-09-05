import type { OperationContext } from '../shared/api.ts';

export const DEFAULT_PARTY_REGISTRY_SHELL_ORIGIN = 'http://localhost:3020';

export const resolvePartyRegistryShellOrigin = (value: string | undefined): string =>
  value !== undefined && value.trim().length > 0 ? value : DEFAULT_PARTY_REGISTRY_SHELL_ORIGIN;

export const partyRegistryCorsAllowedHeaders = [
  'Accept',
  'Accept-Language',
  'Authorization',
  'B3',
  'Content-Type',
  'Idempotency-Key',
  'Traceparent',
  'X-Correlation-Id',
  'X-Modernjs-Bff-Operation-Context',
  'X-Operation-Id',
  'X-Trace-Id',
] as const;

export const partyRegistryCorsAllowedMethods = ['GET', 'HEAD', 'OPTIONS', 'POST'] as const;

export const partyRegistryCorsAllowedOrigins = (configuredOrigin: string): readonly string[] => {
  const origin = new URL(configuredOrigin);
  if (origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
    return [origin.origin];
  }
  const port = origin.port.length === 0 ? '' : `:${origin.port}`;
  return [`http://localhost${port}`, `http://127.0.0.1${port}`];
};

interface PartyRegistryOperationAttributes extends Record<string, string | undefined> {
  'modernjs.operation.id': string;
  'modernjs.operation.method': string;
  'modernjs.operation.route': string;
  'modernjs.operation.source': string;
  'modernjs.trace.id'?: string;
}

export const operationAttributes = (operationContext: OperationContext) => {
  const attributes: PartyRegistryOperationAttributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  if (operationContext.traceId !== undefined) {
    attributes['modernjs.trace.id'] = operationContext.traceId;
  }
  return attributes;
};
