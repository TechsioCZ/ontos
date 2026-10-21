// CRM persistence + ACL (owned by crm-scaffold). One JSONB document per (tenant, legal entity), optimistic
// revision. The viewer (principal + context permissions + salesperson record) is computed here for every read
// and command; projections and reducers in shared/ enforce it (C00).
import { ContextAccess, OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { makeReferenceGatewayCredentialSource } from '@app/gateway-principal-verifier/server';
import { executeCounterpartyReadWithAuthorization } from '@app/party-registry/api/client';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import {
  CrmPermissionDenied,
  CrmPersistenceUnavailable,
  CrmReferenceIneligible,
  CrmReferenceUnavailable,
  CrmRevisionConflict,
  CrmScopeMismatch,
} from '../../shared/actions/apply-command.ts';
import type { CrmCommand } from '../../shared/actions/apply-command.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import type { VerifiedParty } from '../../shared/commands/context.ts';
import { dispatchCrmCommand, partyLinksOf } from '../../shared/commands/index.ts';
import type { PartyLinkInput } from '../../shared/domain/clients.ts';
import type { CrmPermissionKey, CrmViewer } from '../../shared/domain/access.ts';
import { canWriteAnything, crmPermissionKeys } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { CrmStateSchema, initialCrmState, projectCrmState, withDefaultSlices } from '../../shared/domain/state.ts';
import { salespersonOfPrincipal } from '../../shared/domain/team.ts';
import { crmStates } from '../database/schema.ts';

const moduleId = 'demo.crm';

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
      reason: 'Party Registry je dočasně nedostupný; vazbu na zákazníka teď nelze ověřit',
    }),
    cause,
  );

const partyIneligible = (reason: string) => new CrmReferenceIneligible({ code: 'crm_reference_ineligible', reason });

const NotVisibleProblem = Schema.Struct({ status: Schema.Literals([403, 404]) });
const isNotVisible = Schema.is(NotVisibleProblem);

interface CounterpartyFacts {
  readonly currentRoles: readonly {
    readonly roleType: string;
    readonly state: string;
    readonly validFrom: string;
    readonly validTo: string | null;
  }[];
  readonly legalEntityRef: { readonly resourceId: string };
  readonly party: {
    readonly archived: boolean;
    readonly canonicalPartyRef: { readonly resourceId: string };
    readonly displayName: string | null;
    readonly storedPartyRef: { readonly resourceId: string };
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
    return 'Zákazník v Party Registry patří jiné firmě';
  }
  if (counterparty.party.archived) {
    return 'Záznam v Party Registry je archivovaný';
  }
  if (
    counterparty.party.canonicalPartyRef.resourceId !== link.partyId &&
    counterparty.party.storedPartyRef.resourceId !== link.partyId
  ) {
    return 'Party a Counterparty v Party Registry k sobě nepatří';
  }
  const customer = counterparty.currentRoles.some(
    (role) =>
      role.roleType === 'CUSTOMER' &&
      role.state === 'ACTIVE' &&
      role.validFrom.slice(0, 10) <= today &&
      (role.validTo === null || role.validTo.slice(0, 10) > today),
  );
  if (!customer) {
    return 'Firma nemá v Party Registry platnou roli zákazníka';
  }
  return {
    counterpartyId: link.counterpartyId,
    ...(counterparty.party.displayName === null ? {} : { displayName: counterparty.party.displayName }),
    partyId: counterparty.party.canonicalPartyRef.resourceId,
  };
};

/** One batched context-permission check for all five CRM permissions. */
const grantedPermissions = Effect.fn('Crm.grantedPermissions')(function* grantedPermissions(
  access: ContextAccess['Service'],
  scope: OperationalScope,
) {
  if (scope.legalEntityId === undefined || access.contextPermissions === undefined) {
    return yield* referenceUnavailable();
  }
  const decisions = yield* access.contextPermissions({
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    targets: crmPermissionKeys.map((permission) => ({ moduleId, permission })),
    tenantId: scope.tenantId,
  });
  if (decisions.length !== crmPermissionKeys.length || decisions.some((entry) => entry.decision === 'unavailable')) {
    return yield* referenceUnavailable();
  }
  const allowed = new Set(
    decisions.filter((entry) => entry.decision === 'allowed').map((entry) => entry.key.replace(`${moduleId}:`, '')),
  );
  return (permission: CrmPermissionKey) => allowed.has(permission);
});

/** The ACL subject of every read and command: permissions + the principal's salesperson record. */
export const viewerFor = (
  state: CrmState,
  principalId: string,
  has: (permission: CrmPermissionKey) => boolean,
): CrmViewer => {
  const salesperson = salespersonOfPrincipal(state.salespeople, principalId);
  const base = {
    assign: has('demo.crm.assign'),
    principalId,
    readAll: has('demo.crm.read_all'),
    readAssigned: has('demo.crm.read_assigned'),
    writeAll: has('demo.crm.write_all'),
    writeAssigned: has('demo.crm.write_assigned'),
  };
  return salesperson === undefined ? base : { ...base, salespersonId: salesperson.id };
};

export { partyLinksOf } from '../../shared/commands/index.ts';

export const persistenceService = Effect.fn('Crm.persistenceService')(
  function* makePersistence(transaction: ScopedTransactionExecutor, scope: OperationalScope) {
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
    const access = yield* ContextAccess;
    // Forwarded single-use assertions of the signed-in principal (header x-ontos-reference-credentials); the
    // registry answers with that principal's own rights, so nobody links a Party they could not read.
    const references = yield* makeReferenceGatewayCredentialSource(scope).pipe(Effect.mapError(referenceUnavailable));
    const verifyParties = Effect.fn('Crm.verifyParties')(function* verifyParties(links: readonly PartyLinkInput[]) {
      const verified = new Map<string, VerifiedParty>();
      const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
      for (const link of links) {
        const credential = yield* references.issue('party-registry').pipe(Effect.mapError(registryUnavailable));
        const counterparty = yield* executeCounterpartyReadWithAuthorization(
          {
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: link.counterpartyId,
              resourceType: 'party.registry.counterparty',
              tenantId: scope.tenantId,
            },
          },
          credential.authorization,
          scope.correlationId,
          { baseUrl: credential.apiBaseUrl, compositionRevision: credential.compositionRevision },
        ).pipe(
          Effect.mapError((failure) =>
            isNotVisible(failure)
              ? partyIneligible('Zákazník v Party Registry neexistuje nebo k němu nemáte přístup')
              : registryUnavailable(failure),
          ),
        );
        const outcome = verifiedPartyOf(link, counterparty, legalEntityId, today);
        if (typeof outcome === 'string') {
          return yield* partyIneligible(outcome);
        }
        verified.set(link.counterpartyId, outcome);
      }
      return verified;
    });
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
          reason: 'CRM changed; refresh before another operation',
        });
      }
      return expectedRevision + 1;
    });
    const apply = Effect.fn('Crm.apply')(function* apply(
      command: CrmCommand,
      expectedRevision: number,
      invocationId: string,
    ) {
      const has = yield* grantedPermissions(access, scope);
      const snapshot = yield* load();
      const viewer = viewerFor(snapshot.state, scope.principalId, has);
      if (!canWriteAnything(viewer)) {
        return yield* new CrmPermissionDenied({
          code: 'crm_permission_denied',
          reason: 'Nemáte oprávnění k zápisu v CRM',
        });
      }
      if (snapshot.revision !== expectedRevision) {
        return yield* new CrmRevisionConflict({
          code: 'crm_revision_conflict',
          reason: 'CRM changed; refresh before another operation',
        });
      }
      const links = partyLinksOf(command);
      const verifiedParties = links.length === 0 ? undefined : yield* verifyParties(links);
      const now = DateTime.formatIso(yield* DateTime.now);
      const context = {
        invocationId,
        now,
        viewer,
        ...(verifiedParties === undefined ? {} : { verifiedParties }),
      };
      const change = yield* dispatchCrmCommand(snapshot.state, command, context);
      const revision = yield* save(expectedRevision, change.state);
      return { entityIds: [...change.entityIds], revision };
    });
    const records = Effect.fn('Crm.records')(function* records(request: RecordsRequest) {
      // Permission resolution and the company-scoped snapshot are independent reads. Do not hold the
      // database read behind the remote permission round trip; still project only after BOTH succeed.
      const [has, snapshot] = yield* Effect.all([grantedPermissions(access, scope), load()], { concurrency: 2 });
      const viewer = viewerFor(snapshot.state, scope.principalId, has);
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
        now: DateTime.formatIso(yield* DateTime.now),
        revision: snapshot.revision,
        state: narrowed,
        viewer,
      } satisfies RecordsResponse;
    });
    return { apply, records };
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
