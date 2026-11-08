import { Schema } from 'effect';
import { agendaCommandSchemas } from '../commands/agenda.ts';
import { ApplyCommandPayloadSchema } from './apply-command.ts';

/** Only the authenticated person's inbox and preferences, never calendar management or delivery. */
export const PersonalAgendaCommandSchema = Schema.Union([
  agendaCommandSchemas[3],
  agendaCommandSchemas[4],
  agendaCommandSchemas[6],
]);
export const UpdatePersonalAgendaPayloadSchema = Schema.Struct({
  baseUpdatedAt: ApplyCommandPayloadSchema.fields.baseUpdatedAt,
  command: PersonalAgendaCommandSchema,
  expectedRevision: ApplyCommandPayloadSchema.fields.expectedRevision,
});
export {
  ApplyCommandResultSchema as UpdatePersonalAgendaResultSchema,
  FacilityOperationsErrorSchema as UpdatePersonalAgendaErrorSchema,
} from './apply-command.ts';
