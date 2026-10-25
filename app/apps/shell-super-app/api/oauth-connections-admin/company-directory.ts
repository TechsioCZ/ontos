import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CompanyDirectorySnapshot, ConnectionsAdminError, ConnectionsCaller } from './ports.ts';

/** Original ingress identity and transport, bound once for the exact selected company. */
export interface CompanyDirectoryTransportRequest {
  readonly correlationId: string;
  readonly idempotencyKey?: string;
}

export interface CompanyDirectoryRequest {
  readonly principal: ConnectionsCaller['principal'];
  readonly transport: CompanyDirectoryTransportRequest;
}

/** Request-bound to the original trusted principal; no caller-supplied scope or actor. */
export interface CompanyDirectoryPort<R> {
  /** Reconcile the already-audited archive Action; never emit a second operator-change command. */
  readonly confirmArchived: (agentPrincipalId: string) => Effect.Effect<void, ConnectionsAdminError, R>;
  /** Commit only when needed, resume pending projection, and confirm before success. */
  readonly replaceOperators: (input: {
    readonly agentPrincipalId: string;
    readonly context: 'agent-created' | 'operators-edited';
    readonly operatorPrincipalIds: readonly string[];
    readonly revokedConnections: number;
    readonly snapshot: CompanyDirectorySnapshot;
  }) => Effect.Effect<void, ConnectionsAdminError, R>;
  readonly snapshot: () => Effect.Effect<CompanyDirectorySnapshot, ConnectionsAdminError, R>;
}

export class CompanyDirectory extends Context.Service<CompanyDirectory, CompanyDirectoryPort<never>>()(
  '@app/shell-super-app/api/oauth-connections-admin/CompanyDirectory',
) {}
