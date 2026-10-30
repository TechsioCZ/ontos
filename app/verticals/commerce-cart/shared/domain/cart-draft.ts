import { CatalogSelectionSchema, ProductUnitRefSchema } from '@app/catalog-selection-contracts';
import { Schema } from 'effect';
import {
  CartActionInvocationIdSchema,
  CartLegalEntityIdSchema,
  CartPrincipalIdSchema,
  CartRevisionIdSchema,
  CartSelectionIdSchema,
  CartTenantIdSchema,
} from '@app/commerce-cart-contracts/resources/cart';
import { CartRefSchema } from '../resources/cart.ts';

export const CartIdentitySchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
export const CartRevisionNumberSchema = Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }));
const CartPopulationGenerationSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u));
export const CartRevisionRefSchema = Schema.Struct({
  resourceRef: CartRefSchema,
  revision: CartRevisionNumberSchema,
  revisionId: CartRevisionIdSchema,
});
export const CartRequestedQuantitySchema = Schema.Struct({
  amount: Schema.String.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u),
    Schema.makeFilter((value) => (/^0(?:\.0+)?$/u.test(value) ? 'Requested quantity must be positive' : undefined)),
  ),
  unitRef: ProductUnitRefSchema,
});
export const CartDraftAddEntrySchema = Schema.Struct({
  kind: Schema.Literal('ADD'),
  quantity: CartRequestedQuantitySchema,
  selection: CatalogSelectionSchema,
}).check(
  Schema.makeFilter(({ quantity, selection }) =>
    quantity.unitRef.tenantId === selection.productRef.tenantId
      ? undefined
      : 'Quantity and Selection Tenant must match',
  ),
);
export const CartDraftRetainEntrySchema = Schema.Struct({
  kind: Schema.Literal('RETAIN'),
  selectionId: CartSelectionIdSchema,
});
export const CartDraftEntryInstructionSchema = Schema.Union([CartDraftAddEntrySchema, CartDraftRetainEntrySchema]);
export const CartHeldSelectionSchema = Schema.Struct({
  createdByPrincipalId: CartPrincipalIdSchema,
  originRevisionId: CartRevisionIdSchema,
  quantity: CartRequestedQuantitySchema,
  selection: CatalogSelectionSchema,
  selectionId: CartSelectionIdSchema,
  sourceActionInvocationId: CartActionInvocationIdSchema,
});
export const CartDraftSchema = Schema.Struct({
  cartRef: CartRefSchema,
  createdAt: Schema.DateTimeUtcFromString,
  entries: Schema.Array(CartHeldSelectionSchema),
  intendedContext: Schema.Struct({
    legalEntityId: CartLegalEntityIdSchema,
    verification: Schema.Literal('UNVERIFIED_PREPARATION'),
  }),
  legalEntityId: CartLegalEntityIdSchema,
  preparationPrincipalId: CartPrincipalIdSchema,
  recordedAt: Schema.DateTimeUtcFromString,
  revisionRef: CartRevisionRefSchema,
  status: Schema.Literals(['OPEN', 'CLOSED']),
}).check(
  Schema.makeFilter((draft) => {
    if (
      draft.intendedContext.legalEntityId !== draft.legalEntityId ||
      draft.revisionRef.resourceRef.resourceId !== draft.cartRef.resourceId ||
      draft.revisionRef.resourceRef.tenantId !== draft.cartRef.tenantId
    ) {
      return 'Cart identity and intended Legal Entity must match';
    }
    if (
      new Set(draft.entries.map(({ selectionId }) => selectionId)).size !== draft.entries.length ||
      draft.entries.some(
        ({ quantity, selection }) =>
          selection.productRef.tenantId !== draft.cartRef.tenantId ||
          quantity.unitRef.tenantId !== draft.cartRef.tenantId,
      )
    ) {
      return 'Cart entries must have distinct owner identities in the Cart Tenant';
    }
    return true;
  }),
);
export const CartDraftMutationResultSchema = Schema.Struct({
  cart: CartDraftSchema,
  populationGeneration: CartPopulationGenerationSchema,
});
export const CartPopulationAuthoritySchema = Schema.Struct({
  generation: CartPopulationGenerationSchema,
  owner: Schema.Literal('commerce.cart'),
  protocol: Schema.Literal('CART_OPEN_SELECTION_POPULATION.v1'),
  tenantId: CartTenantIdSchema,
});
export class CartDraftRejected extends Schema.TaggedError<CartDraftRejected>()('CartDraftRejected', {
  code: Schema.Literals([
    'cart_authority_unavailable',
    'cart_population_unavailable',
    'cart_not_found',
    'cart_permission_denied',
    'cart_revision_conflict',
    'cart_closed',
    'cart_entry_invalid',
    'cart_input_invalid',
  ]),
  reason: Schema.String,
}) {}
export type CartDraft = typeof CartDraftSchema.Type;
export type CartHeldSelection = typeof CartHeldSelectionSchema.Type;
export type CartDraftEntryInstruction = typeof CartDraftEntryInstructionSchema.Type;
