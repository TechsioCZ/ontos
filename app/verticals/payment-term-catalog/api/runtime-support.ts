export { microVerticalOperationAttributes as operationAttributes } from '@app/shared-contracts';

const DEFAULT_SHELL_ORIGIN = 'http://localhost:3020';

export const resolvePaymentTermCatalogShellOrigin = (value?: string): string =>
  value !== undefined && value.trim().length > 0 ? value : DEFAULT_SHELL_ORIGIN;

export const paymentTermCatalogCorsAllowedHeaders = [
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

export const paymentTermCatalogCorsAllowedMethods = ['GET', 'HEAD', 'OPTIONS', 'POST'] as const;

export const paymentTermCatalogCorsAllowedOrigins = (
  configuredOrigin: string,
): readonly string[] => {
  const origin = new URL(configuredOrigin);
  if (origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
    return [origin.origin];
  }
  const port = origin.port.length === 0 ? '' : `:${origin.port}`;
  return [`http://localhost${port}`, `http://127.0.0.1${port}`];
};
