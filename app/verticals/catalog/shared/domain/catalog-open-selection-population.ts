/* eslint-disable effect-native/require-context-service-for-service-interface -- The public Context service is declared in cart-open-selection-population-service.ts to satisfy the one-class-per-file rule; owner: Catalog #479; tracking: #398; expires: 2027-03-31. */
import { Effect, Option, Schema } from 'effect';

import { CatalogRevisionInstantSchema, CatalogRevisionTenantIdSchema } from './catalog-revision-reference.ts';
import type { CatalogSelectionOwnerAssessmentResult } from './catalog-selection-owner-contract.ts';
import type { CatalogSelectionPurpose } from './catalog-selection-purpose.ts';
import { CatalogSelectionSchema } from './catalog-selection-evidence.ts';
import type { CatalogSelection } from './catalog-selection-evidence.ts';
import { CartOpenSelectionPopulationService } from './cart-open-selection-population-service.ts';

export { CartOpenSelectionPopulationService } from './cart-open-selection-population-service.ts';

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const cartSelectionIdSchema = nonEmptyText.pipe(Schema.brand('CartOpenSelectionId'));

/**
 * One open selection as declared by its owning Cart. `selectionId` is the Cart-issued durable
 * identity; `selection` is the exact Catalog Selection the Cart is holding open. Catalog never
 * derives either from its own rows.
 */
export const CartOpenSelectionReferenceSchema = Schema.Struct({
  selection: CatalogSelectionSchema,
  selectionId: cartSelectionIdSchema,
});
export type CartOpenSelectionReference = typeof CartOpenSelectionReferenceSchema.Type;

/**
 * The Cart owner's attestation that this is the complete durable open-selection population for
 * the Tenant at `observedAt`. Catalog treats an absent, failing, or partial population as a typed
 * unavailable outcome and never manufactures an empty population from DRAFT/WIP/unavailable data.
 */
export const CartOpenSelectionPopulationEvidenceSchema = Schema.Struct({
  complete: Schema.Literal(true),
  observedAt: CatalogRevisionInstantSchema,
  revisionToken: nonEmptyText,
  selections: Schema.Array(CartOpenSelectionReferenceSchema),
  tenantId: CatalogRevisionTenantIdSchema,
}).check(
  Schema.makeFilter(({ selections, tenantId }) => {
    if (selections.some(({ selection }) => selection.productRef.tenantId !== tenantId)) {
      return 'Every open Selection must belong to the attested Tenant';
    }
    return new Set(selections.map(({ selectionId }) => selectionId)).size === selections.length
      ? undefined
      : 'Open Selection identities must be unique';
  }),
);
export type CartOpenSelectionPopulationEvidence = typeof CartOpenSelectionPopulationEvidenceSchema.Type;

/** Typed "Catalog does not own this fact" outcome for the Cart open-selection population. */
export class CartOpenSelectionPopulationUnavailable extends Schema.TaggedError<CartOpenSelectionPopulationUnavailable>()(
  'CartOpenSelectionPopulationUnavailable',
  { code: Schema.Literal('cart_open_selection_population_unavailable'), reason: Schema.String },
) {}

/**
 * Injected owner contract. The port is built at the composition boundary from Cart's own durable
 * source; Catalog never imports Cart's private tables, registration, or executable behavior. An
 * absent port or a failing read is a typed unavailable outcome, never an empty population.
 */
export interface CartOpenSelectionPopulationPort {
  readonly read: (input: {
    readonly tenantId: string;
  }) => Effect.Effect<unknown, CartOpenSelectionPopulationUnavailable>;
}

/**
 * Resolve the deployment-provided Cart owner port while preserving absence as `undefined`. An
 * unbound deployment remains fail-closed instead of manufacturing an empty population.
 */
export const cartOpenSelectionPopulationFromEnvironment: Effect.Effect<CartOpenSelectionPopulationPort | undefined> =
  Effect.serviceOption(CartOpenSelectionPopulationService).pipe(Effect.map(Option.getOrUndefined));

/** Decode and scope-check the foreign owner response before Catalog trusts its completeness claim. */
export const readCartOpenSelectionPopulation = Effect.fn('CartOpenSelectionPopulationPort.read')(function* read(
  port: CartOpenSelectionPopulationPort,
  tenantId: string,
) {
  const raw = yield* port.read({ tenantId });
  const population = yield* Schema.decodeUnknownEffect(CartOpenSelectionPopulationEvidenceSchema)(raw).pipe(
    Effect.mapError((cause) =>
      Object.assign(
        new CartOpenSelectionPopulationUnavailable({
          code: 'cart_open_selection_population_unavailable',
          reason: 'Cart returned an invalid open-selection population attestation',
        }),
        { cause },
      ),
    ),
  );
  if (population.tenantId !== tenantId) {
    return yield* new CartOpenSelectionPopulationUnavailable({
      code: 'cart_open_selection_population_unavailable',
      reason: 'Cart returned an open-selection population for a different Tenant',
    });
  }
  return population;
});

/**
 * Catalog's own #479 evidence reader. It is the Catalog-owned half of any open-selection
 * decision: the exact-selection Current assessment. Foreign owner facts still enter only through
 * their own injected ports.
 */
export interface CatalogSelectionEvidenceReader {
  readonly assess: (input: {
    readonly purpose: CatalogSelectionPurpose;
    readonly selection: CatalogSelection;
  }) => Effect.Effect<{ readonly evidence: CatalogSelectionOwnerAssessmentResult }>;
}

/** A selection references the exact Product when owner, Resource, and Tenant all match. */
export const openSelectionReferencesProduct = (
  selection: CatalogSelection,
  product: { readonly resourceId: string; readonly tenantId: string },
): boolean =>
  selection.productRef.moduleId === 'commerce.catalog' &&
  selection.productRef.tenantId === product.tenantId &&
  selection.productRef.resourceId === product.resourceId;
