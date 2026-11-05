import { DateTime, Effect } from 'effect';
import type { Crypto } from 'effect';

import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { AccessChangesStoreService } from '../changes/persistence/store.ts';
import { withOptional } from '../decision/optional.ts';
import type { AccessPrincipalKinds } from '../enforcement/actor.ts';
import type { AccessRecordProjectionPort } from '../enforcement/record-projection-port.ts';
import { ProposalIdSchema } from '../ids.ts';
import type { AccessTransactions } from '../intent/persistence.ts';
import type { TenantIntentLoaderService } from '../intent/tenant-intent-loader.ts';
import type { MandateDispatchDependencies } from './action-mandate-dispatch.ts';
import type { ApprovalStoreService } from './drizzle-store.ts';
import { ApprovalStorageUnavailableError } from './errors.ts';
import type { FrozenCommandStore } from './frozen-command.ts';
import { liveApprovalScopeAdministration } from './live-administration.ts';
import { liveApprovalAuthorityInspector } from './live-authority.ts';
import type { LiveAuthoritySources } from './live-authority.ts';
import { livePublishedCatalog } from './live-catalog.ts';
import type { ApprovalClock, ApprovalIdentifiers, ApprovalsPorts } from './service.ts';

/*
 * The real ports of the approvals service and of the mandate adapter: every one of them is a Core
 * service that already ships, and nothing here decides authority itself.
 *
 * - the catalog is the published release the Novinky store reads (O1);
 * - the witnesses are the intent loader's live cells plus the membership rows and the owner's record
 *   projection (O48, O49, R2-H1);
 * - the administrators are the configure bases of the exact scope, proved against the membership path
 *   the canonical schema requires (O28, O61);
 * - the records are the shipped Drizzle store, and the clock and the identifiers are Effect's own
 *   (O60, O66).
 *
 * The scope is not only a filter, it is the source of every read. `liveApprovalsPorts` reads the
 * request's scope in transactions of its own, which is what every non-Action caller needs. A mandate
 * claim is the other case (O75): it runs inside the owner Action's transaction, holding the proposal's
 * lock there, and an authority fact read through a second connection would describe another instant —
 * and on one connection PostgreSQL refuses the nested transaction outright. `liveApprovalsPorts`
 * therefore offers `inTransaction` only when the composition can really join one: its intent loader,
 * membership rows, role bindings and approvals store are then all built over
 * `callerTransactions(caller transaction)`, so the very same query and verdict code answers from the
 * caller's transaction. Nothing is re-decided here and no fact is scripted.
 *
 * This module deliberately assembles PORTS, not a service: `makeApprovalsService` belongs to
 * `service.ts`, and Core's lint policy keeps a capability's constructor inside its owning module
 * (`anti-slop-effect/no-service-constructor-imports`). The owning module therefore closes the last
 * line — `liveApprovalsService` in `service.ts` — and this file states the ports it needs.
 *
 * Three limits are deliberate and belong to their owners, not here:
 *
 * - a record-scoped command needs the published release to name the read that governs the record
 *   (D30). `CatalogSnapshotEntry` carries no such field today, so a live catalog answers "not named"
 *   and the shipped policy refuses that approval instead of inventing a read. Publishing the
 *   governing read is a catalog/declaration change;
 * - a witness held by a record-scoped selector needs the owner's projection of the record (D32). The
 *   transaction-bound composition binds NO projection: an owner port cannot be rebound to the
 *   caller's transaction from here, and a projection that read the pool would answer about the record
 *   outside the transaction whose authority is being claimed. Until that port can join a transaction,
 *   a record-scoped reach stays unanswered — which the verdict reports as unavailability, never as a
 *   reach (fail-closed, not a widened grant);
 * - the isolation of a joined read is the caller's. A read that opens its own transaction asks for
 *   REPEATABLE READ; one that runs inside the owner's transaction cannot, and does not claim to, so
 *   the owner decides the snapshot its mandate is proved against (`AccessTransactions`).
 */

const storageUnavailable = (reason: string) =>
  new ApprovalStorageUnavailableError({ code: 'approval_storage_unavailable', reason });

/** The approval deadline is the Effect clock's instant, never an ambient `Date.now` (O60). */
const liveClock: ApprovalClock = Object.freeze({ now: DateTime.nowAsDate });

/** A proposal identifier from Effect's crypto service; a failure is retryable unavailability. */
const liveIdentifiers = (crypto: Crypto.Crypto): ApprovalIdentifiers =>
  Object.freeze({
    nextProposalId: crypto.randomUUIDv4().pipe(
      Effect.map((identifier) => ProposalIdSchema.make(identifier)),
      Effect.catchTag('PlatformError', () =>
        Effect.fail(storageUnavailable('An identifier for this proposal could not be generated')),
      ),
    ),
  });

/** The three intent reads the live composition needs, taken as ports of one request scope (O66). */
export interface LiveApprovalIntentReads {
  readonly loadAuthorityCells: TenantIntentLoaderService['loadAuthorityCells'];
  readonly loadConfigureBases: TenantIntentLoaderService['loadConfigureBases'];
  readonly loadTeamIds: TenantIntentLoaderService['loadTeamIds'];
}

/** The shipped approvals store, asked for the record view of one request scope (O66). */
export interface LiveApprovalRecords {
  readonly recordsFor: ApprovalStoreService['recordsFor'];
}

/**
 * Every source the live approvals ports read; each is a service Core already owns.
 *
 * `transactions` is where every read of this composition runs: over `requestTransactions` each read
 * opens a transaction of the request's scope, and over `callerTransactions(ownerTransaction)` every
 * read runs inside the transaction an owner Action already holds (O75).
 *
 * `join` is the owner's own answer to "the same services, over this transaction": only the module that
 * constructs the intent loader, the approvals store and the changes store holds their constructors,
 * and this composition may not import them. Whoever wires the live approvals — the Action runner's
 * owner — supplies it. A composition that cannot join a transaction supplies none, and then no
 * `inTransaction` is offered at all: a mandate claim and a parked Action proposal are unavailable
 * rather than proved by a second connection.
 */
export interface LiveApprovalServices {
  readonly crypto: Crypto.Crypto;
  readonly intent: LiveApprovalIntentReads;
  /** The same services over the transaction a caller already owns; absent refuses every claim (O75). */
  readonly join?: (transaction: CoreTransaction) => LiveApprovalServices;
  /** The published release, exactly as Novinky reads it: the newest published snapshot (O1). */
  readonly loadRelease: AccessChangesStoreService['loadPublishedCatalog'];
  /** The owner's projection of one record; absent leaves a record-scoped reach unanswered (D32). */
  readonly recordProjection?: AccessRecordProjectionPort;
  readonly records: LiveApprovalRecords;
  /** Where the reads of this composition run: a transaction per read, or the caller's own. */
  readonly transactions: AccessTransactions;
}

/**
 * The ports of one request scope over one transaction source — the caller's own transaction when it
 * has one, and otherwise a transaction of the scope per read.
 */
const portsOver = (
  services: LiveApprovalServices,
  scope: OperationalScope,
  transaction?: CoreTransaction,
): ApprovalsPorts => {
  // Without `join` there is no transaction-bound composition and no `inTransaction` below, so this
  // never answers a caller's transaction from the pool.
  const { join } = services;
  const active = transaction !== undefined && join !== undefined ? join(transaction) : services;
  const catalog = livePublishedCatalog(active.loadRelease);
  const sources: LiveAuthoritySources = {
    intent: active.intent,
    moduleKeyOf: catalog.moduleKeyOf,
    scope,
    transactions: active.transactions,
  };
  const ports: ApprovalsPorts = {
    administrators: liveApprovalScopeAdministration({
      intent: active.intent,
      scope,
      transactions: active.transactions,
    }),
    authority: liveApprovalAuthorityInspector(
      // A record-scoped reach is the owner's projection of one record (D32). Only the ordinary
      // composition binds it: a transaction-bound claim must not answer that reach from a pool read.
      transaction === undefined ? withOptional(sources, 'recordProjection', services.recordProjection) : sources,
    ),
    catalog,
    clock: liveClock,
    identifiers: liveIdentifiers(services.crypto),
    store: active.records.recordsFor(scope),
  };
  /*
   * `inTransaction` exists only when the composition can really join a transaction: a composition that
   * cannot is one whose ports say so by omission, which the service refuses instead of proving the
   * claim here through the pool (O75).
   */
  return join === undefined
    ? ports
    : { ...ports, inTransaction: (owner: CoreTransaction) => portsOver(services, scope, owner) };
};

/**
 * The approvals ports of one request scope: one published release, that scope's records and the live
 * reads of witnesses, administration, clock and identifiers.
 */
export const liveApprovalsPorts = (services: LiveApprovalServices, scope: OperationalScope): ApprovalsPorts =>
  portsOver(services, scope);

/**
 * The mandate adapter's own ports, over the live approvals factory and Core's stores. The owner
 * runner supplies `approvalsFor` and decides whether to bind the adapter at all.
 */
export const liveMandateDispatchPorts = (input: {
  readonly approvalsFor: MandateDispatchDependencies['approvalsFor'];
  /** The adapter's own reads (`prepare`, a stored 202) are request reads, never a claim's read. */
  readonly database: { readonly executor: CoreDatabaseExecutor };
  readonly frozenCommands: FrozenCommandStore;
  readonly principalKinds: AccessPrincipalKinds;
}): MandateDispatchDependencies => ({
  approvalsFor: input.approvalsFor,
  database: input.database,
  frozenCommands: input.frozenCommands,
  principalKinds: input.principalKinds,
});
