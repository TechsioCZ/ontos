import { Context, Crypto, Effect, Layer } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { AccessChangesStore } from '../changes/persistence/store.ts';
import type { AccessScopeId, PrincipalId } from '../ids.ts';
import { TenantIdSchema } from '../ids.ts';
import { requestTransactions } from '../intent/persistence.ts';
import { TenantIntentLoader } from '../intent/tenant-intent-loader.ts';
import type { Proposal } from '../model.ts';
import { ApprovalStore } from './drizzle-store.ts';
import type { ApprovalAuthorityUnavailableError, ApprovalStorageUnavailableError } from './errors.ts';
import type { FrozenCommandStore } from './frozen-command.ts';
import { FrozenCommands } from './frozen-command.ts';
import { liveApprovalScopeAdministration } from './live-administration.ts';
import type { ScopeRow } from './live-authority.ts';
import { readTenantMembershipRows } from './live-authority.ts';
import type { LiveApprovalServices } from './live-composition.ts';
import type { ApprovalsService } from './service.ts';
import { liveApprovalsService } from './service.ts';

/*
 * The approval inbox as a request surface reads and decides it ("Ke schválení"): the open proposals of
 * one tenant, the frozen command behind each, who administers a scope, and the live approvals service
 * of one request scope. Every port is the shipped live one (`live-composition.ts`); nothing here
 * decides authority itself.
 *
 * The composition deliberately binds NO `join`. Without it the approvals ports offer no
 * `inTransaction`, so `execute` — and a proposal parked into an owner Action's transaction — stays
 * unavailable from this surface: a mandate is never claimed through a second connection, and the
 * mandate dispatch stays unbound until the Action lane proves exactly-once execution (O75, P6). Approve,
 * reject and withdraw need no owner transaction and work over the request's own transactions.
 */

export interface AccessApprovalsInboxService {
  /** The live approvals service of one request scope; its `execute` is unavailable by construction. */
  readonly approvals: (scope: OperationalScope) => ApprovalsService;
  /** The stored command a proposal froze; a missing record is `None`, a corrupt one an integrity refusal. */
  readonly frozenCommand: FrozenCommandStore['load'];
  /** Whether a person administers one exact scope of the request's tenant (O61). */
  readonly isAdministrator: (
    scope: OperationalScope,
    input: { readonly principalId: PrincipalId; readonly scopeId: AccessScopeId },
  ) => Effect.Effect<boolean, ApprovalAuthorityUnavailableError>;
  /** Every open (pending or approved) proposal of the request's tenant. */
  readonly open: (scope: OperationalScope) => Effect.Effect<readonly Proposal[], ApprovalStorageUnavailableError>;
  /** The access scopes of the request's tenant, each with the company it belongs to, if any. */
  readonly scopes: (scope: OperationalScope) => Effect.Effect<readonly ScopeRow[], ApprovalAuthorityUnavailableError>;
}

export class AccessApprovalsInbox extends Context.Service<AccessApprovalsInbox, AccessApprovalsInboxService>()(
  '@app/core-runtime/access/approvals/inbox/AccessApprovalsInbox',
) {}

export const AccessApprovalsInboxLive: Layer.Layer<
  AccessApprovalsInbox,
  never,
  | AccessChangesStore
  | ApprovalStore
  | CoreDatabase
  | Crypto.Crypto
  | DatabaseIdentityEnrollmentContext
  | FrozenCommands
  | TenantIntentLoader
> = Layer.effect(
  AccessApprovalsInbox,
  Effect.gen(function* accessApprovalsInboxLayer() {
    const database = yield* CoreDatabase;
    const crypto = yield* Crypto.Crypto;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const frozenCommands = yield* FrozenCommands;
    const records = yield* ApprovalStore;
    const changes = yield* AccessChangesStore;
    const intent = yield* TenantIntentLoader;
    const transactions = requestTransactions({ enrollment, executor: database.executor });
    // No `join`: the ports of this composition never answer a caller's transaction (see above).
    const services: LiveApprovalServices = {
      crypto,
      intent,
      loadRelease: () => changes.loadPublishedCatalog(),
      records,
      transactions,
    };
    const inbox: AccessApprovalsInboxService = {
      approvals: (scope) => liveApprovalsService(services, scope),
      frozenCommand: frozenCommands.load,
      isAdministrator: (scope, input) =>
        liveApprovalScopeAdministration({ intent, scope, transactions }).isAdministrator({
          principalId: input.principalId,
          scopeId: input.scopeId,
          tenantId: TenantIdSchema.make(scope.tenantId),
        }),
      open: (scope) => records.recordsFor(scope).listOpen({ tenantId: TenantIdSchema.make(scope.tenantId) }),
      scopes: (scope) =>
        readTenantMembershipRows({ scope, transactions }).pipe(Effect.map(({ scopeRows }) => scopeRows)),
    };
    return Object.freeze(inbox);
  }),
);
