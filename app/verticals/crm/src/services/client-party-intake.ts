import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import {
  CrmNotFound,
  CrmRevisionConflict,
  CrmReferenceIneligible,
  CrmPersistenceUnavailable,
} from '../../shared/actions/apply-command.ts';
import type { IntakeClientPartyPayload, IntakeClientPartyResult } from '../../shared/actions/client-party-intake.ts';
import type { VerifiedParty } from '../../shared/commands/context.ts';
import { correlateCustomerLinks } from '../../shared/commands/clients.ts';
import { CrmStateSchema, initialCrmState, withDefaultSlices } from '../../shared/domain/state.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { EntityIdSchema, PrincipalIdSchema } from '../../shared/domain/common.ts';
import { PendingClientIntakeResponseSchema } from '../../shared/apis/pending-client-intake.ts';
import { crmStates } from '../database/schema.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new CrmPersistenceUnavailable({
      code: 'crm_persistence_unavailable',
      reason: 'Client identity reconciliation is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );
const conflict = () =>
  new CrmRevisionConflict({
    code: 'crm_revision_conflict',
    reason: 'CRM changed while the client identity was being verified',
  });

export const requireIntakeClient = (state: CrmState, clientId: string) =>
  Effect.succeed(state.clients.items.find((client) => client.id === clientId)).pipe(
    Effect.filterOrFail(
      (client) => client !== undefined,
      () => new CrmNotFound({ code: 'crm_not_found', reason: 'The client does not exist in the intake company' }),
    ),
  );

/** Narrow owner mutation, with no viewer, human impersonation or invented general write grant. */
export const linkVerifiedIntakeParty = Effect.fn('Crm.linkVerifiedIntakeParty')(function* linkVerifiedIntakeParty(
  state: CrmState,
  clientId: string,
  party: VerifiedParty,
  input: { readonly invocationId: string; readonly principalId: string },
) {
  const client = yield* requireIntakeClient(state, clientId);
  if (client.partyRef?.counterpartyId !== undefined) {
    return yield* new CrmReferenceIneligible({
      code: 'crm_reference_ineligible',
      reason: 'Intake cannot replace an existing registry identity',
    });
  }
  const ico = (client.regNo ?? '').replaceAll(/\s+/gu, '');
  if (
    state.clients.items.some(
      (entry) =>
        entry.id !== client.id &&
        (entry.partyRef?.counterpartyId === party.counterpartyId || entry.partyRef?.partyId === party.partyId) &&
        (ico === '' || (entry.regNo ?? '').replaceAll(/\s+/gu, '') !== ico),
    )
  ) {
    return yield* new CrmReferenceIneligible({
      code: 'crm_reference_ineligible',
      reason: 'The verified registry identity already belongs to another CRM client',
    });
  }
  const now = yield* DateTime.now;
  const principalId = PrincipalIdSchema.make(input.principalId);
  const baseRef = {
    counterpartyId: party.counterpartyId,
    linkedAt: now,
    linkedBy: principalId,
    partyId: party.partyId,
  };
  const partyRef = party.displayName === undefined ? baseRef : { ...baseRef, registryName: party.displayName };
  return correlateCustomerLinks({
    ...state,
    clients: {
      ...state.clients,
      events: [
        ...(state.clients.events ?? []),
        {
          at: now,
          by: principalId,
          clientId: client.id,
          id: EntityIdSchema.make(`${input.invocationId}-party-intake`),
          kind: 'party_linked',
          subject: party.displayName ?? client.name,
        },
      ],
      items: state.clients.items.map((entry) =>
        entry.id === client.id ? { ...entry, partyRef, updatedAt: now } : entry,
      ),
    },
  });
});

/** Core installs the selected company independently of payload data. This purpose reads no other scope. */
export const clientIntakeRepository = Effect.fn('Crm.clientIntake.repository')(function* repository(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) {
  const { legalEntityId } = scope;
  if (
    legalEntityId === undefined ||
    transaction.scope.tenantId !== scope.tenantId ||
    transaction.scope.legalEntityId !== legalEntityId
  ) {
    return yield* new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Client intake requires its exact scoped company transaction',
    });
  }
  const where = and(eq(crmStates.tenantId, scope.tenantId), eq(crmStates.legalEntityId, legalEntityId));
  const load = Effect.fn('Crm.clientIntake.load')(function* load() {
    const [row] = yield* transaction
      .select({ revision: crmStates.revision, state: crmStates.state })
      .from(crmStates)
      .where(where)
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return row === undefined
      ? { revision: 0, state: initialCrmState }
      : {
          revision: row.revision,
          state: yield* Schema.decodeUnknownEffect(CrmStateSchema)(withDefaultSlices(row.state)).pipe(
            Effect.mapError(unavailable),
          ),
        };
  });
  const pending = Effect.fn('Crm.clientIntake.pending')(function* pending(clientIds?: readonly string[]) {
    let selected = sql`c->>'status' = 'active'`;
    if (clientIds !== undefined) {
      selected =
        clientIds.length === 0
          ? sql`false`
          : sql`c->>'id' in (${sql.join(
              clientIds.map((id) => sql`${id}`),
              sql`, `,
            )})`;
    }
    const [row] = yield* transaction
      .select({
        items: sql`(select coalesce(jsonb_agg(jsonb_build_object('id', c->>'id', 'linked', coalesce(c->'partyRef'->>'counterpartyId', '') <> '')), '[]'::jsonb) from jsonb_array_elements(coalesce(${crmStates.state}->'clients'->'items', '[]'::jsonb)) c where ${selected})`,
        revision: crmStates.revision,
      })
      .from(crmStates)
      .where(where)
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return yield* Schema.decodeUnknownEffect(PendingClientIntakeResponseSchema)(row ?? { items: [], revision: 0 }).pipe(
      Effect.mapError(unavailable),
    );
  });
  const link = Effect.fn('Crm.clientIntake.link')(function* link(
    payload: IntakeClientPartyPayload,
    party: Option.Option<VerifiedParty>,
    invocationId: string,
  ) {
    const current = yield* load();
    if (current.revision !== payload.expectedRevision) {
      return yield* conflict();
    }
    const client = yield* requireIntakeClient(current.state, payload.clientId);
    if (client.partyRef?.counterpartyId !== undefined) {
      return {
        entityIds: [client.id],
        revision: current.revision,
        status: 'unchanged',
      } satisfies IntakeClientPartyResult;
    }
    if (Option.isNone(party)) {
      return { entityIds: [], revision: current.revision, status: 'review' } satisfies IntakeClientPartyResult;
    }
    const state = yield* linkVerifiedIntakeParty(current.state, client.id, party.value, {
      invocationId,
      principalId: scope.principalId,
    });
    const encoded = yield* Schema.encodeEffect(CrmStateSchema)(state).pipe(Effect.mapError(unavailable));
    const rows = yield* transaction
      .update(crmStates)
      .set({ revision: current.revision + 1, state: encoded, updatedAt: yield* DateTime.nowAsDate })
      .where(and(where, eq(crmStates.revision, current.revision)))
      .returning({ revision: crmStates.revision })
      .pipe(Effect.mapError(unavailable));
    if (rows.length !== 1) {
      return yield* conflict();
    }
    return {
      entityIds: [client.id],
      revision: current.revision + 1,
      status: 'linked',
    } satisfies IntakeClientPartyResult;
  });
  return { link, load, pending };
});
