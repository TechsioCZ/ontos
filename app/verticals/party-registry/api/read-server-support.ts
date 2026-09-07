export { microVerticalOperationAttributes as operationAttributes } from '@app/shared-contracts';

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

export const governedReadProblemStatus = {
  authentication: 401,
  forbidden: 403,
  internal: 500,
  invalid: 400,
  notFound: 404,
  policyConflict: 409,
  policyDenied: 422,
  unavailable: 503,
} as const;

export const partyRegistryCorsAllowedOrigins = (configuredOrigin: string): readonly string[] => {
  const origin = new URL(configuredOrigin);
  if (origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
    return [origin.origin];
  }
  const port = origin.port.length === 0 ? '' : `:${origin.port}`;
  return [`http://localhost${port}`, `http://127.0.0.1${port}`];
};
