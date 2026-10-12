import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { MerchandiseScopeMismatch } from '../errors/merchandise-scope-mismatch.ts';
import { MerchandiseNotFound } from '../errors/merchandise-not-found.ts';
import { MerchandiseLifecycleConflict } from '../errors/merchandise-lifecycle-conflict.ts';
import { MerchandiseRevisionConflict } from '../errors/merchandise-revision-conflict.ts';
import { MerchandisePersistenceUnavailable } from '../errors/merchandise-persistence-unavailable.ts';
import { MerchandiseReferenceUnavailable } from '../errors/merchandise-reference-unavailable.ts';
import { MerchandiseReferenceIneligible } from '../errors/merchandise-reference-ineligible.ts';
import { MerchandisePermissionDenied } from '../errors/merchandise-permission-denied.ts';
import {
  CalendarDateSchema,
  ContextRefSchema,
  ProductPrioritySchema,
  ProductSchema,
  ProductStateSchema,
} from '../apis/records.ts';
import { ProductRefSchema } from '../resources/product.ts';

const editableFields = {
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  dueDate: Schema.optionalKey(CalendarDateSchema),
  ownerPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  priority: Schema.optionalKey(ProductPrioritySchema),
};
export const MerchandiseCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateProduct', {
    ...editableFields,
    contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
    title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct('UpdateProduct', {
    ...editableFields,
    productRef: ProductRefSchema,
    title: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
  Schema.TaggedStruct('AssignProduct', { ownerPrincipalRef: PrincipalRefSchema, productRef: ProductRefSchema }),
  Schema.TaggedStruct('ChangeProductState', { productRef: ProductRefSchema, state: ProductStateSchema }),
]);
export type MerchandiseCommand = typeof MerchandiseCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: MerchandiseCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({ product: ProductSchema, revision: Schema.Int });
export const MerchandiseErrorSchema = Schema.Union([
  MerchandiseScopeMismatch,
  MerchandiseNotFound,
  MerchandiseLifecycleConflict,
  MerchandiseRevisionConflict,
  MerchandisePersistenceUnavailable,
  MerchandiseReferenceUnavailable,
  MerchandiseReferenceIneligible,
  MerchandisePermissionDenied,
]);
export type MerchandiseError = typeof MerchandiseErrorSchema.Type;
export { MerchandiseScopeMismatch } from '../errors/merchandise-scope-mismatch.ts';
export { MerchandiseNotFound } from '../errors/merchandise-not-found.ts';
export { MerchandiseLifecycleConflict } from '../errors/merchandise-lifecycle-conflict.ts';
export { MerchandiseRevisionConflict } from '../errors/merchandise-revision-conflict.ts';
export { MerchandisePersistenceUnavailable } from '../errors/merchandise-persistence-unavailable.ts';
export { MerchandiseReferenceUnavailable } from '../errors/merchandise-reference-unavailable.ts';
export { MerchandiseReferenceIneligible } from '../errors/merchandise-reference-ineligible.ts';
export { MerchandisePermissionDenied } from '../errors/merchandise-permission-denied.ts';
