// AREA: team (C00, CRM.md §8 "správce založí dva obchodníky A/B"). Salespeople are company accounts (Core
// principals) that a správce or vedoucí registers in the CRM; only registered, active salespeople can own clients.
// The account itself (sign-in, role, deactivation) stays in Core / "Lidé a role"; this only adds the CRM record.
import { Effect, Match, Schema } from 'effect';
import { EntityIdSchema, PrincipalIdSchema, ShortTextSchema } from '../domain/common.ts';
import type { CrmState } from '../domain/state.ts';
import type { Salesperson } from '../domain/team.ts';
import type { Reducer } from './context.ts';
import { conflict, definedOnly, newId, notFound, requireAssign } from './context.ts';

const OptionalText = Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(200)));

export const teamCommandSchemas = [
  Schema.TaggedStruct('RegisterSalesperson', {
    email: OptionalText,
    name: ShortTextSchema,
    phone: OptionalText,
    /** Core principal of the company account that becomes the salesperson. */
    principalId: PrincipalIdSchema,
  }),
  Schema.TaggedStruct('SetSalespersonActive', {
    active: Schema.Boolean,
    salespersonId: EntityIdSchema,
  }),
] as const;
export const TeamCommandSchema = Schema.Union(teamCommandSchemas);
export type TeamCommand = typeof TeamCommandSchema.Type;

const withSalespeople = (state: CrmState, salespeople: readonly Salesperson[]): CrmState => ({ ...state, salespeople });

export const applyTeamCommand: Reducer<TeamCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag('RegisterSalesperson', (value) =>
      Effect.gen(function* registerSalesperson() {
        yield* requireAssign(context);
        const existing = state.salespeople.find((person) => person.principalId === value.principalId);
        if (existing !== undefined) {
          return yield* conflict(
            existing.active
              ? `Účet je už veden jako obchodník ${existing.name}`
              : `Účet je veden jako vyřazený obchodník ${existing.name}; vraťte ho mezi aktivní`,
          );
        }
        const id = newId(context, 'salesperson');
        const salesperson: Salesperson = {
          ...definedOnly({ email: value.email, phone: value.phone }),
          active: true,
          id,
          name: value.name,
          principalId: value.principalId,
          registeredAt: context.now,
          registeredBy: context.viewer.principalId,
        };
        return { entityIds: [id], state: withSalespeople(state, [...state.salespeople, salesperson]) };
      }),
    ),
    Match.tag('SetSalespersonActive', (value) =>
      Effect.gen(function* setSalespersonActive() {
        yield* requireAssign(context);
        const person = state.salespeople.find((entry) => entry.id === value.salespersonId);
        if (person === undefined) {
          return yield* notFound('Obchodník neexistuje');
        }
        if (person.active === value.active) {
          return yield* conflict(value.active ? 'Obchodník je už aktivní' : 'Obchodník je už vyřazen');
        }
        if (!value.active) {
          const owned = state.clients.items.filter(
            (client) => client.status === 'active' && client.ownerSalespersonId === person.id,
          ).length;
          if (owned > 0) {
            return yield* conflict(
              `Obchodník má ${owned} aktivních klientů; nejprve je převeďte jinému obchodníkovi (historie zůstane)`,
            );
          }
        }
        const next: Salesperson = {
          ...person,
          active: value.active,
          activeChangedAt: context.now,
          activeChangedBy: context.viewer.principalId,
        };
        return {
          entityIds: [person.id],
          state: withSalespeople(
            state,
            state.salespeople.map((entry) => (entry.id === person.id ? next : entry)),
          ),
        };
      }),
    ),
    Match.exhaustive,
  );
