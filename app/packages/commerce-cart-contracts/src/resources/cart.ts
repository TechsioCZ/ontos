// Canonical schema-only relocation of the Codesmith commerce.cart Cart resource contract.
import { Schema } from 'effect';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
export const CartTenantIdSchema = checkedUuid.pipe(Schema.brand('CartTenantId'), Schema.decodeTo(checkedUuid));
export const CartResourceIdSchema = checkedUuid.pipe(Schema.brand('CartResourceId'), Schema.decodeTo(checkedUuid));
export const CartRevisionIdSchema = checkedUuid.pipe(Schema.brand('CartRevisionId'), Schema.decodeTo(checkedUuid));
export const CartSelectionIdSchema = checkedUuid.pipe(Schema.brand('CartSelectionId'), Schema.decodeTo(checkedUuid));
export const CartPrincipalIdSchema = checkedUuid.pipe(Schema.brand('CartPrincipalId'), Schema.decodeTo(checkedUuid));
export const CartLegalEntityIdSchema = checkedUuid.pipe(
  Schema.brand('CartLegalEntityId'),
  Schema.decodeTo(checkedUuid),
);
export const CartActionInvocationIdSchema = checkedUuid.pipe(
  Schema.brand('CartActionInvocationId'),
  Schema.decodeTo(checkedUuid),
);
export const CartRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.cart'),
  resourceId: CartResourceIdSchema,
  resourceType: Schema.Literal('commerce.cart.cart'),
  tenantId: CartTenantIdSchema,
});
export type CartRef = typeof CartRefSchema.Type;
