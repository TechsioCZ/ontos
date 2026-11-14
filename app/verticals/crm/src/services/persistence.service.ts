import { activeAssignmentMember, loadAssignablePrincipalDirectory } from '@app/core-runtime/auth/assignable-principals';
import { assignmentPrincipalIds } from './assignment-policy.ts';
// CRM persistence + ACL (owned by crm-scaffold). One JSONB document per (tenant, legal entity), optimistic
// revision. The viewer (principal + the reach the one access gate resolved + salesperson record) is computed
// here for every read and command; projections and reducers in shared/ enforce it (C00).
import {
  AccessKeySchema,
  agentHistoryPageSql,
  isConnectionWriteAllowed,
  OperationContextUnavailable,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { AccessDecisionGate, capabilityPolicyOf } from '@app/core-runtime/access/enforcement';
import type { GateCarrier } from '@app/core-runtime/access/enforcement';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';

import { makeReferenceGatewayCredentialSource } from '@app/gateway-principal-verifier/server';
import { CounterpartyReadRequestSchema } from '@app/party-registry/api';
import type { CounterpartyReadResponse } from '@app/party-registry/api';
import { executeCounterpartyReadWithAuthorization } from '@app/party-registry/api/client';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  CrmPermissionDenied,
  CrmPersistenceUnavailable,
  CrmReferenceIneligible,
  CrmReferenceUnavailable,
  CrmRevisionConflict,
  CrmScopeMismatch,
  CrmCommandSchema,
} from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayload, CrmCommand } from '../../shared/actions/apply-command.ts';

import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { VerifiedPartySchema } from '../../shared/commands/context.ts';
import type { CommandContext, VerifiedParty } from '../../shared/commands/context.ts';
import { PrincipalIdSchema } from '../../shared/domain/common.ts';
import type { PrincipalId } from '../../shared/domain/common.ts';

import { dispatchCrmCommand, partyLinksOf } from '../../shared/commands/index.ts';
import type { PartyLinkInput } from '../../shared/domain/clients.ts';
import { canWriteAnything, crmRecordSelectorOf, viewerFor as viewerFromGrants } from '../../shared/domain/access.ts';
import type { CrmGrants, CrmRecordSelector, CrmViewer } from '../../shared/domain/access.ts';
import {
  crmApplyCommandDeclaration,
  crmClientOwnerAssignGroup,
  crmRecordsReadDeclaration,
} from '../../shared/domain/access-declarations.ts';

import { CrmStateSchema, initialCrmState, projectCrmState, withDefaultSlices } from '../../shared/domain/state.ts';
import type { CrmState } from '../../shared/domain/state.ts';

import { salespersonOfPrincipal } from '../../shared/domain/team.ts';
import { crmStates } from '../database/schema.ts';

const moduleId = 'demo.crm';
const crmRevisionConflictReason = 'CRM changed; refresh before another operation';

const withCause = <E extends object>(error: E, cause: unknown) =>
  Object.defineProperty(error, 'cause', { enumerable: false, value: cause });

const unavailable = (cause?: unknown) =>
  withCause(
    new CrmPersistenceUnavailable({
      code: 'crm_persistence_unavailable',
      reason: 'CRM persistence is temporarily unavailable',
    }),
    cause,
  );

const referenceUnavailable = (cause?: unknown) =>
  withCause(
    new CrmReferenceUnavailable({
      code: 'crm_reference_unavailable',
      reason: 'Permission decisions are temporarily unavailable',
    }),
    cause,
  );

const registryUnavailable = (cause?: unknown) =>
  withCause(
    new CrmReferenceUnavailable({
      code: 'crm_reference_unavailable',
      reason: 'Evidence zákazníků je dočasně nedostupná; vazbu na zákazníka teď nelze ověřit',
    }),
    cause,
  );

const partyIneligible = (reason: string) => new CrmReferenceIneligible({ code: 'crm_reference_ineligible', reason });

const NotVisibleProblem = Schema.Struct({ status: Schema.Literals([403, 404]) });
const isNotVisible = Schema.is(NotVisibleProblem);

interface CounterpartyFacts {
  readonly currentRoles: readonly Pick<
    CounterpartyReadResponse['currentRoles'][number],
    'roleType' | 'state' | 'validFrom' | 'validTo'
  >[];
  readonly legalEntityRef: Pick<CounterpartyReadResponse['legalEntityRef'], 'resourceId'>;
  readonly party: {
    readonly archived: CounterpartyReadResponse['party']['archived'];
    readonly canonicalPartyRef: Pick<CounterpartyReadResponse['party']['canonicalPartyRef'], 'resourceId'>;
    readonly displayName?: CounterpartyReadResponse['party']['displayName'];
    readonly storedPartyRef: Pick<CounterpartyReadResponse['party']['storedPartyRef'], 'resourceId'>;
  };
}

/** A registry answer is usable when it is a current CUSTOMER of the scoped company and names the same Party. */
export const verifiedPartyOf = (
  link: PartyLinkInput,
  counterparty: CounterpartyFacts,
  legalEntityId: string,
  today: string,
): VerifiedParty | string => {
  if (counterparty.legalEntityRef.resourceId !== legalEntityId) {
    return 'Zákazník v evidenci zákazníků patří jiné firmě';
  }
  if (counterparty.party.archived) {
    return 'Záznam v evidenci zákazníků je archivovaný';
  }
  if (
    counterparty.party.canonicalPartyRef.resourceId !== link.partyId &&
    counterparty.party.storedPartyRef.resourceId !== link.partyId
  ) {
    return 'Údaje o firmě a zákazníkovi k sobě nepatří';
  }
  const customer = counterparty.currentRoles.some(
    (role) =>
      role.roleType === 'CUSTOMER' &&
      role.state === 'ACTIVE' &&
      role.validFrom.slice(0, 10) <= today &&
      (role.validTo === null || role.validTo.slice(0, 10) > today),
  );
  if (!customer) {
    return 'Firma nemá v evidenci zákazníků platnou roli zákazníka';
  }
  const candidate = { counterpartyId: link.counterpartyId, partyId: counterparty.party.canonicalPartyRef.resourceId };
  if (counterparty.party.displayName !== null && counterparty.party.displayName !== undefined) {
    Object.assign(candidate, { displayName: counterparty.party.displayName });
  }
  return Option.getOrElse(
    Schema.decodeOption(VerifiedPartySchema)(candidate),
    () => 'Údaje o firmě a zákazníkovi k sobě nepatří',
  );
};

/**
 * The three CRM declarations the owner asks the one access gate about (ADR-0030). Each carrier is the
 * shared declaration with its key branded, so the descriptor and this owner can never name a
 * different capability. Nothing here grants: the gate answers, the owner only reads its answer.
 */
const crmRecordsReadCarrier = {
  accessDeclaration: { ...crmRecordsReadDeclaration, key: AccessKeySchema.make(crmRecordsReadDeclaration.key) },
} satisfies GateCarrier;
const crmApplyCommandCarrier = {
  accessDeclaration: { ...crmApplyCommandDeclaration, key: AccessKeySchema.make(crmApplyCommandDeclaration.key) },
} satisfies GateCarrier;
const crmClientOwnerAssignCarrier = {
  accessDeclaration: { ...crmClientOwnerAssignGroup, key: AccessKeySchema.make(crmClientOwnerAssignGroup.key) },
} satisfies GateCarrier;

/** The record selector a resolved list predicate stands for; a reach it cannot describe is no reach. */
const readSelectorOf = (
  predicate: ListAccessPredicate | undefined,
  principalId: string,
): CrmRecordSelector | undefined => (predicate === undefined ? undefined : crmRecordSelectorOf(predicate, principalId));

/**
 * The one access gate's answer about this principal in this company: the reach over the records read,
 * whether it may change CRM at all, and whether it may reassign a client owner. An engine that cannot
 * answer is retryable, never an allow (O48b).
 */
const crmGrants = Effect.fn('Crm.grants')(function* crmGrants(scope: OperationalScope) {
  if (scope.legalEntityId === undefined) {
    return yield* referenceUnavailable();
  }
  const gate = yield* AccessDecisionGate;
  const question = {
    legalEntityScope: 'required' as const,
    now: DateTime.toDateUtc(yield* DateTime.now),
    scope,
  };
  // One bounded batch: the write and reassignment decisions and the records read's row predicate.
  const [decisions, listing] = yield* Effect.all(
    [
      gate.decideMany([
        { ...question, carrier: crmApplyCommandCarrier },
        {
          ...question,
          carrier: crmClientOwnerAssignCarrier,
          parentRead: { capability: capabilityPolicyOf(crmApplyCommandCarrier.accessDeclaration) },
        },
      ]),
      gate.list({ ...question, carrier: crmRecordsReadCarrier }),
    ],
    { concurrency: 1 },
  );
  const [write, assign] = decisions;
  if (write === undefined || assign === undefined) {
    return yield* referenceUnavailable();
  }
  if (
    write.outcome === 'UNAVAILABLE' ||
    assign.outcome === 'UNAVAILABLE' ||
    listing.decision.outcome === 'UNAVAILABLE'
  ) {
    return yield* referenceUnavailable();
  }
  const assignAllowed = assign.outcome === 'ALLOWED';
  const writeAllowed = write.outcome === 'ALLOWED';
  const readSelector =
    listing.decision.outcome === 'ALLOWED' ? readSelectorOf(listing.predicate, scope.principalId) : undefined;
  return readSelector === undefined
    ? { assign: assignAllowed, write: writeAllowed }
    : { assign: assignAllowed, readSelector, write: writeAllowed };
});

/** The ACL subject of every read and command: permissions + the principal's salesperson record. */
export const viewerFor = (state: CrmState, principalId: PrincipalId, grants: CrmGrants): CrmViewer => {
  const salesperson = salespersonOfPrincipal(state.salespeople, principalId);
  return viewerFromGrants(grants, principalId, salesperson?.id);
};

/**
 * The viewer a records read reports. A read-only or approval-only MCP connection cannot change CRM directly, so its
 * write flags are off; read reach stays exactly as before (the assigned write reach also lets a salesperson read).
 */
export const reportedViewer = (
  viewer: CrmViewer,
  scope: Pick<OperationalScope, 'authMethod' | 'connection'>,
): CrmViewer =>
  isConnectionWriteAllowed(scope, moduleId)
    ? viewer
    : {
        ...viewer,
        assign: false,
        readAll: viewer.readAll || viewer.writeAll,
        readAssigned: viewer.readAssigned || viewer.writeAssigned,
        writeAll: false,
        writeAssigned: false,
      };

export { partyLinksOf } from '../../shared/commands/index.ts';

const verifyCrmParties = Effect.fn('Crm.verifyParties')(function* verifyCrmParties(
  links: readonly PartyLinkInput[],
  scope: OperationalScope,
) {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return yield* referenceUnavailable();
  }
  const references = yield* makeReferenceGatewayCredentialSource(scope).pipe(Effect.mapError(referenceUnavailable));
  const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
  return yield* Effect.reduce(
    links,
    () => new Map<string, VerifiedParty>(),
    Effect.fn('Crm.verifyParty')(function* verifyParty(
      previous: ReadonlyMap<string, VerifiedParty>,
      link: PartyLinkInput,
    ) {
      const credential = yield* references.issue('party-registry').pipe(Effect.mapError(registryUnavailable));
      const counterparty = yield* executeCounterpartyReadWithAuthorization(
        yield* Schema.decodeUnknownEffect(CounterpartyReadRequestSchema)({
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: link.counterpartyId,
            resourceType: 'party.registry.counterparty',
            tenantId: scope.tenantId,
          },
        }).pipe(Effect.mapError(registryUnavailable)),
        credential.authorization,
        scope.correlationId,
        { baseUrl: credential.apiBaseUrl, compositionRevision: credential.compositionRevision },
      ).pipe(
        Effect.mapError((failure) =>
          isNotVisible(failure)
            ? partyIneligible('Zákazník v evidenci zákazníků neexistuje nebo k němu nemáte přístup')
            : registryUnavailable(failure),
        ),
      );
      const outcome = verifiedPartyOf(link, counterparty, legalEntityId, today);
      if (Schema.is(Schema.String)(outcome)) {
        return yield* partyIneligible(outcome);
      }
      return new Map([...previous, [link.counterpartyId, outcome]]);
    }),
  );
});
interface CrmCommandPreparation {
  readonly actionInvocationId: string;
  readonly grants: CrmGrants;
  readonly payload: ApplyCommandPayload;
  readonly verifiedParties: ReadonlyMap<string, VerifiedParty> | null;
}
const sameCommand = Schema.toEquivalence(CrmCommandSchema);
export const prepareCrmCommand = Effect.fn('Crm.prepareCommand')(function* prepareCommand(
  payload: ApplyCommandPayload,
  context: ActionServicePreparationContext,
) {
  const { scope } = context;
  if (scope.legalEntityId === undefined) {
    return yield* referenceUnavailable();
  }
  const grants = yield* crmGrants(scope);
  if (!grants.write) {
    return yield* new CrmPermissionDenied({ code: 'crm_permission_denied', reason: 'Nemáte oprávnění k zápisu v CRM' });
  }
  const links = partyLinksOf(payload.command);
  if (links.length === 0) {
    return { grants, verifiedParties: null };
  }
  const { legalEntityId } = scope;
  const revision = yield* context.transaction((transaction) =>
    transaction
      .select({ revision: crmStates.revision })
      .from(crmStates)
      .where(and(eq(crmStates.tenantId, scope.tenantId), eq(crmStates.legalEntityId, legalEntityId)))
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        Effect.map(([row]) => row?.revision ?? 0),
      ),
  );
  if (revision !== payload.expectedRevision) {
    return yield* new CrmRevisionConflict({
      code: 'crm_revision_conflict',
      reason: crmRevisionConflictReason,
    });
  }
  // The snapshot has released its SQL connection before any credential or owner call begins.
  const verifiedParties = yield* verifyCrmParties(links, scope);
  return { grants, verifiedParties };
});

export const persistenceService = Effect.fn('Crm.persistenceService')(
  function* makePersistence(
    transaction: ScopedTransactionExecutor,
    options: { readonly prepared?: CrmCommandPreparation; readonly scope: OperationalScope },
  ) {
    const { prepared, scope } = options;
    const { legalEntityId } = scope;
    if (
      legalEntityId === undefined ||
      transaction.scope.tenantId !== scope.tenantId ||
      transaction.scope.legalEntityId !== legalEntityId
    ) {
      return yield* new CrmScopeMismatch({
        code: 'crm_scope_mismatch',
        reason: 'A scoped company transaction is required',
      });
    }
    const whereScope = and(eq(crmStates.tenantId, scope.tenantId), eq(crmStates.legalEntityId, legalEntityId));
    const load = Effect.fn('Crm.load')(function* load() {
      const rows = yield* transaction.select().from(crmStates).where(whereScope).limit(1);
      const [row] = rows;
      if (row === undefined) {
        return { revision: 0, state: initialCrmState };
      }
      const state = yield* Schema.decodeUnknownEffect(CrmStateSchema)(withDefaultSlices(row.state));
      return { revision: row.revision, state };
    }, Effect.mapError(unavailable));
    const save = Effect.fn('Crm.save')(function* save(expectedRevision: number, state: CrmState) {
      const encoded = yield* Schema.encodeEffect(CrmStateSchema)(state).pipe(
        Effect.mapError((cause) => unavailable(cause)),
      );
      const updatedAt = yield* DateTime.now;
      if (expectedRevision === 0) {
        const inserted = yield* transaction
          .insert(crmStates)
          .values({
            legalEntityId,
            revision: 1,
            state: encoded,
            tenantId: scope.tenantId,
            updatedAt: DateTime.toDateUtc(updatedAt),
          })
          .onConflictDoNothing()
          .returning({ revision: crmStates.revision })
          .pipe(Effect.mapError((cause) => unavailable(cause)));
        if (inserted.length === 1) {
          return 1;
        }
      }
      const rows = yield* transaction
        .update(crmStates)
        .set({ revision: expectedRevision + 1, state: encoded, updatedAt: DateTime.toDateUtc(updatedAt) })
        .where(and(whereScope, eq(crmStates.revision, expectedRevision)))
        .returning({ revision: crmStates.revision })
        .pipe(Effect.mapError((cause) => unavailable(cause)));
      if (rows.length !== 1) {
        return yield* new CrmRevisionConflict({
          code: 'crm_revision_conflict',
          reason: crmRevisionConflictReason,
        });
      }
      return expectedRevision + 1;
    });
    const apply = Effect.fn('Crm.apply')(function* apply(
      command: CrmCommand,
      expectedRevision: number,
      invocationId: string,
    ) {
      if (
        prepared === undefined ||
        prepared.actionInvocationId !== invocationId ||
        prepared.payload.expectedRevision !== expectedRevision ||
        !sameCommand(prepared.payload.command, command)
      ) {
        return yield* referenceUnavailable();
      }
      const { grants } = prepared;
      const snapshot = yield* load();
      const actorPrincipalId = yield* Schema.decodeEffect(PrincipalIdSchema)(scope.principalId).pipe(
        Effect.mapError(referenceUnavailable),
      );
      const viewer = viewerFor(snapshot.state, actorPrincipalId, grants);
      if (!canWriteAnything(viewer)) {
        return yield* new CrmPermissionDenied({
          code: 'crm_permission_denied',
          reason: 'Nemáte oprávnění k zápisu v CRM',
        });
      }
      if (snapshot.revision !== expectedRevision) {
        return yield* new CrmRevisionConflict({
          code: 'crm_revision_conflict',
          reason: crmRevisionConflictReason,
        });
      }
      const targets = assignmentPrincipalIds(command, snapshot.state, scope.principalId);
      if (targets.length > 0) {
        const directory = yield* loadAssignablePrincipalDirectory(transaction, scope).pipe(
          Effect.mapError(referenceUnavailable),
        );
        yield* Effect.forEach(
          new Set(targets),
          (principalId) =>
            activeAssignmentMember(directory, { principalId, tenantId: scope.tenantId }).pipe(
              Effect.mapError((cause) =>
                withCause(partyIneligible('Vybraný obchodník již nemá aktivní členství ve firmě.'), cause),
              ),
            ),
          { concurrency: 1, discard: true },
        );
      }
      const { verifiedParties } = prepared;
      const now = yield* DateTime.now;
      const context: CommandContext = { invocationId, now, viewer };
      if (verifiedParties !== null) {
        Object.assign(context, { verifiedParties });
      }
      const change = yield* dispatchCrmCommand(snapshot.state, command, context);
      const revision = yield* save(expectedRevision, change.state);
      return { entityIds: [...change.entityIds], revision };
    });
    /** Ordinary records, bounded history, or only the clients needed by the owner review. */
    type LoadRecordsArgs = [grants: CrmGrants, request?: RecordsRequest, reviewClientIds?: readonly string[]];
    const loadRecords = Effect.fn('Crm.loadRecords')(
      function* loadCrmRecords(...[grants, request = {}, reviewClientIds]: LoadRecordsArgs) {
        const empty = yield* Schema.encodeEffect(Schema.fromJsonString(CrmStateSchema))(initialCrmState);
        const historySource = sql`${crmStates.state}->'aiChanges'`;
        const history =
          request.agentHistory === undefined
            ? undefined
            : agentHistoryPageSql(historySource, 'crm', request.agentHistory);
        let state =
          request.agentHistory === undefined
            ? sql`${crmStates.state}`
            : sql`(${empty}::jsonb || jsonb_build_object('aiChanges', ${history}))`;
        if (reviewClientIds !== undefined) {
          const ids = sql.join(
            reviewClientIds.map((id) => sql`${id}`),
            sql`, `,
          );
          const target = reviewClientIds.length === 0 ? sql`false` : sql`c->>'id' in (${ids})`;
          state = sql`(${empty}::jsonb || jsonb_build_object(
          'clients', (${empty}::jsonb->'clients') || jsonb_build_object('items',
            coalesce((select jsonb_agg(c) from (select c from jsonb_array_elements(coalesce(${crmStates.state}->'clients'->'items', '[]'::jsonb)) c
              where ${target} limit ${reviewClientIds.length}) clients), '[]'::jsonb)),
          'salespeople', coalesce((select jsonb_agg(p) from (select p from jsonb_array_elements(coalesce(${crmStates.state}->'salespeople', '[]'::jsonb)) p
            where p->>'principalId' = ${scope.principalId} and p->>'active' = 'true' limit 1) people), '[]'::jsonb)))`;
        }
        if (grants.readSelector !== 'all') {
          const own = grants.readSelector === 'assigned' || grants.readSelector === 'entrusted';
          // Apply the owner reach inside SQL. Contacts, visits, orders and history use exactly the
          // same visible client ids; neither a search nor a direct lookup fetches another rep's data.
          state = sql`(with source as (select ${state} as s),
            visible_clients as (
              select c from source, jsonb_array_elements(coalesce(s->'clients'->'items', '[]'::jsonb)) c
              where ${own} and exists (
                select 1 from jsonb_array_elements(coalesce(s->'salespeople', '[]'::jsonb)) p
                where p->>'id' = c->>'ownerSalespersonId'
                  and p->>'principalId' = ${scope.principalId} and p->>'active' = 'true'
              )
            ),
            visible_orders as (
              select o - 'candidates' as o from source,
                jsonb_array_elements(coalesce(s->'imports'->'orders', '[]'::jsonb)) o
              where o->>'clientId' in (select c->>'id' from visible_clients)
            )
            select s || jsonb_build_object(
              'aiChanges', jsonb_build_object('batches', '[]'::jsonb, 'changes', '[]'::jsonb, 'log', '[]'::jsonb),
              'salespeople', coalesce((select jsonb_agg(p) from jsonb_array_elements(coalesce(s->'salespeople', '[]'::jsonb)) p
                where p->>'principalId' = ${scope.principalId}), '[]'::jsonb),
              'clients', jsonb_build_object(
                'items', coalesce((select jsonb_agg(c) from visible_clients), '[]'::jsonb),
                'contacts', coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'clients'->'contacts', '[]'::jsonb)) v
                  where v->>'clientId' in (select c->>'id' from visible_clients)), '[]'::jsonb),
                'assignmentHistory', coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'clients'->'assignmentHistory', '[]'::jsonb)) v
                  where v->>'clientId' in (select c->>'id' from visible_clients)), '[]'::jsonb),
                'events', coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'clients'->'events', '[]'::jsonb)) v
                  where v->>'clientId' in (select c->>'id' from visible_clients)), '[]'::jsonb)),
              'visits', jsonb_build_object(
                'items', coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'visits'->'items', '[]'::jsonb)) v
                  where v->>'clientId' in (select c->>'id' from visible_clients) and v->'archive' is null), '[]'::jsonb),
                'plan', coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'visits'->'plan', '[]'::jsonb)) v
                  where v->>'clientId' in (select c->>'id' from visible_clients)), '[]'::jsonb)),
              'imports', jsonb_build_object(
                'batches', '[]'::jsonb,
                'orders', coalesce((select jsonb_agg(o) from visible_orders), '[]'::jsonb),
                'customerLinks', coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'imports'->'customerLinks', '[]'::jsonb)) v
                  where v->>'clientId' in (select c->>'id' from visible_clients)), '[]'::jsonb),
                'pairingHistory', coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'imports'->'pairingHistory', '[]'::jsonb)) v
                  where v->>'orderId' in (select o->>'id' from visible_orders)), '[]'::jsonb))
            ) from source)`;
        }
        return yield* transaction
          .select({ revision: crmStates.revision, state })
          .from(crmStates)
          .where(whereScope)
          .limit(1)
          .pipe(Effect.map(([row]): LoadedCrmRecords => Option.fromNullishOr(row)));
      },
      (program, ..._args: LoadRecordsArgs) => program.pipe(Effect.mapError(unavailable)),
    );
    const loadAssignmentDirectory = (grants: CrmGrants) =>
      loadAssignablePrincipalDirectory(transaction, scope).pipe(
        Effect.mapError(unavailable),
        Effect.map((directory) =>
          grants.readSelector === 'all'
            ? directory
            : {
                ...directory,
                members: directory.members.filter((member) => member.principalRef.principalId === scope.principalId),
              },
        ),
      );
    return { apply, loadAssignmentDirectory, loadRecords };
  },
  Effect.mapError((cause) =>
    withCause(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Owner-scoped services are temporarily unavailable',
      }),
      cause,
    ),
  ),
);

/** What a records read knows before its transaction opens: every CRM permission, in one bulk check. */
export const crmRecordsGrants = Effect.fn('Crm.recordsGrants')(function* crmRecordsGrants(scope: OperationalScope) {
  return yield* crmGrants(scope);
});

/** The stored CRM row as the owner transaction read it (still encoded). */
export type LoadedCrmRecords = Option.Option<{ readonly revision: number; readonly state: unknown }>;

/** After commit: decodes the stored CRM state and projects it for the viewer. No database access. */
export const finishCrmRecords = Effect.fn('Crm.finishRecords')(function* finishCrmRecords(
  request: RecordsRequest,
  loaded: LoadedCrmRecords,
  grants: CrmGrants,
  scope: OperationalScope,
) {
  const snapshot = Option.isNone(loaded)
    ? { revision: 0, state: initialCrmState }
    : {
        revision: loaded.value.revision,
        state: yield* Schema.decodeUnknownEffect(CrmStateSchema)(withDefaultSlices(loaded.value.state)).pipe(
          Effect.mapError(unavailable),
        ),
      };
  const actorPrincipalId = yield* Schema.decodeEffect(PrincipalIdSchema)(scope.principalId).pipe(
    Effect.mapError(referenceUnavailable),
  );
  const viewer = viewerFor(snapshot.state, actorPrincipalId, grants);
  const projected = projectCrmState(snapshot.state, viewer);
  const narrowed =
    request.clientId === undefined
      ? projected
      : projectCrmState(
          {
            ...projected,
            clients: {
              ...projected.clients,
              items: projected.clients.items.filter((client) => client.id === request.clientId),
            },
          },
          viewer,
        );
  return {
    now: yield* DateTime.now,
    revision: snapshot.revision,
    state: narrowed,
    viewer: reportedViewer(viewer, scope),
  } satisfies Omit<RecordsResponse, 'assignmentCandidates' | 'departedPrincipalIds'>;
});
