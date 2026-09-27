import { Data } from 'effect';

export class TenantModuleStateReadUnavailableError extends Data.TaggedError('TenantModuleStateReadUnavailableError')<{
  readonly cause?: unknown;
  readonly code: 'tenant_module_state_read_unavailable';
  readonly reason: string;
}> {}
