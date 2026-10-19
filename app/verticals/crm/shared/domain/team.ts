// Salespeople (Obchodníci) of the CRM company. A salesperson is linked to a Core principal, which is how the
// server maps the signed-in principal to "my clients" (see ./access.ts). Seeded by scripts/reset-demo.mts.
import { Schema } from 'effect';
import { EntityIdSchema, PrincipalIdSchema, ShortTextSchema } from './common.ts';

export const SalespersonSchema = Schema.Struct({
  active: Schema.Boolean,
  email: Schema.optionalKey(ShortTextSchema),
  id: EntityIdSchema,
  name: ShortTextSchema,
  phone: Schema.optionalKey(ShortTextSchema),
  principalId: Schema.optionalKey(PrincipalIdSchema),
});
export type Salesperson = typeof SalespersonSchema.Type;

export const salespersonOfPrincipal = (salespeople: readonly Salesperson[], principalId: string) =>
  salespeople.find((person) => person.principalId === principalId);
