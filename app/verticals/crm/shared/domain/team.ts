// Salespeople (Obchodníci) of the CRM company. A salesperson is linked to a Core principal, which is how the
// server maps the signed-in principal to "my clients" (see ./access.ts). Seeded by scripts/reset-demo.mts; a správce
// or vedoucí registers further company accounts as salespeople (RegisterSalesperson) and deactivates them.
import { Schema } from 'effect';
import { EntityIdSchema, IsoTimeSchema, PrincipalIdSchema, ShortTextSchema } from './common.ts';

export const SalespersonSchema = Schema.Struct({
  active: Schema.Boolean,
  /** Last activation change (deactivated salespeople keep their history, but see no clients). */
  activeChangedAt: Schema.optionalKey(IsoTimeSchema),
  activeChangedBy: Schema.optionalKey(PrincipalIdSchema),
  email: Schema.optionalKey(ShortTextSchema),
  id: EntityIdSchema,
  name: ShortTextSchema,
  phone: Schema.optionalKey(ShortTextSchema),
  principalId: Schema.optionalKey(PrincipalIdSchema),
  registeredAt: Schema.optionalKey(IsoTimeSchema),
  registeredBy: Schema.optionalKey(PrincipalIdSchema),
});
export type Salesperson = typeof SalespersonSchema.Type;

/** The principal's ACTIVE salesperson record; a deactivated salesperson no longer reaches "my clients". */
export const salespersonOfPrincipal = (salespeople: readonly Salesperson[], principalId: string) =>
  salespeople.find((person) => person.principalId === principalId && person.active);
