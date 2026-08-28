import { Schema } from 'effect';

export const DEFAULT_PROJECTS_SHELL_ORIGIN = 'http://localhost:3020';

const ShellOriginSchema = Schema.String;

export const resolveProjectsShellOrigin = <Value>(value?: Value): string =>
  Schema.is(ShellOriginSchema)(value) ? value : DEFAULT_PROJECTS_SHELL_ORIGIN;

export const projectsCorsAllowedHeaders = [
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

export const projectsCorsAllowedMethods = ['GET', 'HEAD', 'OPTIONS', 'POST'] as const;

export const projectsCorsAllowedOrigins = (configuredOrigin: string) => {
  const origin = new URL(configuredOrigin);
  if (origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
    return [origin.origin];
  }
  const port = origin.port.length === 0 ? '' : `:${origin.port}`;
  return [`http://localhost${port}`, `http://127.0.0.1${port}`];
};
