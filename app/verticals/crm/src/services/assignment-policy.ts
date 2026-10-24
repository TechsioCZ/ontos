import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';
import { loadAssignmentPreflightSnapshot, resolveAssignee } from '@app/core-runtime/auth/assignable-principals';
import { and, eq } from 'drizzle-orm';
import { Effect, Match, Schema } from 'effect';
import type { ApplyCommandPayload, CrmCommand } from '../../shared/actions/apply-command.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { CrmStateSchema, initialCrmState, withDefaultSlices } from '../../shared/domain/state.ts';
import { crmStates } from '../database/schema.ts';

export const crmAssignmentPermission = { moduleId: 'demo.crm', permission: 'module.access' } as const;

/** Historical owners stay in the document. Only a deliberate new assignment needs a current target. */
export const assignmentPrincipalIds = (command: CrmCommand, state: CrmState, actorId: string): readonly string[] => {
  const principalOf = (salespersonId: string | undefined) => {
    if (salespersonId === undefined) {
      return [];
    }
    const person = state.salespeople.find((candidate) => candidate.id === salespersonId);
    // An unbound historical record must never become a new assignment target.
    return [person?.principalId ?? ''];
  };
  const own = state.salespeople.find((person) => person.principalId === actorId && person.active)?.id;
  return Match.value(command).pipe(
    Match.tag('RegisterSalesperson', (value) => [value.principalId]),
    Match.tag('SetSalespersonActive', (value) => (value.active ? principalOf(value.salespersonId) : [])),
    Match.tag('AssignClient', (value) =>
      state.clients.items.find((client) => client.id === value.clientId)?.ownerSalespersonId === value.toSalespersonId
        ? []
        : principalOf(value.toSalespersonId),
    ),
    Match.tag('CreateClient', (value) => principalOf(value.ownerSalespersonId ?? own)),
    Match.tag('RecordVisit', 'PlanContact', (value) =>
      principalOf(
        value.salespersonId ??
          own ??
          state.clients.items.find((client) => client.id === value.clientId)?.ownerSalespersonId,
      ),
    ),
    Match.tag('AiProposeChanges', (value) =>
      value.changes.flatMap(({ operation }) => assignmentPrincipalIds(operation, state, actorId)),
    ),
    Match.tag('AiDecideChanges', (value) => {
      if (value.decision !== 'approve') {
        return [];
      }
      const selected = new Set(value.changeIds);
      return (state.aiChanges?.changes ?? []).flatMap((change) =>
        selected.has(change.id) ? assignmentPrincipalIds(change.operation, state, actorId) : [],
      );
    }),
    Match.orElse(() => []),
  );
};

const requiresPreflight = (command: CrmCommand) =>
  Match.value(command).pipe(
    Match.tag(
      'RegisterSalesperson',
      'AssignClient',
      'CreateClient',
      'RecordVisit',
      'PlanContact',
      'AiProposeChanges',
      () => true,
    ),
    Match.tag('AiDecideChanges', (value) => value.decision === 'approve'),
    Match.tag('SetSalespersonActive', (value) => value.active),
    Match.orElse(() => false),
  );

export const assignmentPolicy = defineMicroverticalPolicy<ApplyCommandPayload, 'demo.crm'>({
  evaluate: Effect.fn('Crm.assignmentPreflight')(
    function* assignmentPreflight({ payload, principal, transport }) {
      if (!requiresPreflight(payload.command)) {
        return;
      }
      const { legalEntityId } = principal;
      if (legalEntityId === undefined) {
        yield* denyPolicy('assignment_scope_required', 'Vyberte firmu.');
        return;
      }
      const { directory, value } = yield* loadAssignmentPreflightSnapshot(
        { ...principal, correlationId: transport.correlationId, legalEntityId },
        Effect.fn('Crm.assignmentSnapshot')(function* assignmentSnapshot(transaction) {
          const [row] = yield* transaction
            .select({ revision: crmStates.revision, state: crmStates.state })
            .from(crmStates)
            .where(and(eq(crmStates.tenantId, principal.tenantId), eq(crmStates.legalEntityId, legalEntityId)))
            .limit(1);
          return row === undefined
            ? { revision: 0, state: initialCrmState }
            : {
                revision: row.revision,
                state: yield* Schema.decodeUnknownEffect(CrmStateSchema)(withDefaultSlices(row.state)),
              };
        }),
      );
      if (value.revision !== payload.expectedRevision) {
        return;
      }
      yield* Effect.forEach(
        new Set(assignmentPrincipalIds(payload.command, value.state, principal.principalId)),
        (principalId) =>
          resolveAssignee(directory, { principalId, tenantId: principal.tenantId }, crmAssignmentPermission),
        { concurrency: 1, discard: true },
      );
    },
    Effect.catchTags({
      AssignablePrincipalsUnavailable: () =>
        Effect.fail(denyPolicy('assignment_unavailable', 'Přístup obchodníka nelze ověřit. Zkuste to znovu.')),
      AssigneeIneligible: () =>
        Effect.fail(denyPolicy('assignment_ineligible', 'Vybraný obchodník nemá aktivní přístup do CRM této firmy.')),
    }),
  ),
  owningModuleKey: 'demo.crm',
  policyKey: 'demo.crm.assignment-target.v1',
});
