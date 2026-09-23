import { Schema } from 'effect';

import type { CatalogSelectionBasisSchema } from './catalog-selection-evidence.ts';
import { CatalogSelectionSchema } from './catalog-selection-evidence.ts';
import { sameCatalogRevisionReference } from './catalog-revision-reference.ts';
import type {
  CatalogRetainedProduct,
  CatalogRetainedVariant,
  CatalogRevisionInstant,
} from './catalog-revision-reference.ts';
import type { CatalogQuantityHandoff } from './catalog-quantity-handoff.ts';
import type { SetCompositionRevision } from './set-composition.ts';

type ReadyQuantity = Extract<CatalogQuantityHandoff, { readonly status: 'READY' }>;

/** An Order-owned historical record, not a claim that any fact remains Current. */
interface CatalogAcceptedSelectionHandoff {
  readonly acceptedAt: CatalogRevisionInstant;
  readonly basis: readonly (typeof CatalogSelectionBasisSchema.Type)[];
  readonly historical: true;
  readonly packageContent?: NonNullable<ReadyQuantity['packageRevision']>;
  readonly packageResolution?: NonNullable<ReadyQuantity['packageContent']>;
  readonly product: CatalogRetainedProduct;
  readonly purpose: string;
  readonly quantity: ReadyQuantity['quantity'];
  readonly selection: ReadyQuantity['selection'];
  readonly setComposition?: SetCompositionRevision;
  readonly variant: CatalogRetainedVariant;
}

export type CatalogAcceptedSelectionHandoffResult =
  | { readonly handoff: CatalogAcceptedSelectionHandoff; readonly status: 'ACCEPTED' }
  | { readonly reason: string; readonly status: 'UNVERIFIABLE' };

interface HandoffInput {
  readonly acceptedAt: CatalogRevisionInstant;
  readonly product?: CatalogRetainedProduct;
  readonly purpose: string;
  readonly quantity: CatalogQuantityHandoff;
  readonly setComposition?: SetCompositionRevision;
  readonly variant?: CatalogRetainedVariant;
}

const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);

const hasBasis = (
  basis: ReadyQuantity['evidence']['basis'],
  role: (typeof CatalogSelectionBasisSchema.Type)['role'],
  revision: (typeof CatalogSelectionBasisSchema.Type)['source'],
): boolean =>
  basis.some(
    (item) => item.subject === undefined && item.role === role && sameCatalogRevisionReference(item.source, revision),
  );

const packageIsProven = (quantity: ReadyQuantity): boolean => {
  const selected = quantity.selection.packageOption;
  if (selected === undefined) {
    return quantity.packageRevision === undefined && quantity.packageContent === undefined;
  }
  return (
    quantity.packageRevision !== undefined &&
    quantity.packageContent !== undefined &&
    sameCatalogRevisionReference(quantity.packageRevision.reference, selected.contentRevision) &&
    hasBasis(quantity.evidence.basis, 'PACKAGE_CONTENT', selected.contentRevision)
  );
};

const setIsProven = (quantity: ReadyQuantity, setComposition: SetCompositionRevision | undefined): boolean => {
  const selected = quantity.selection.setComposition;
  if (selected === undefined) {
    return setComposition === undefined;
  }
  return (
    setComposition !== undefined &&
    sameCatalogRevisionReference(setComposition.reference, selected) &&
    sameRef(setComposition.productRef, quantity.selection.productRef) &&
    sameRef(setComposition.variantRef, quantity.selection.variantRef) &&
    hasBasis(quantity.evidence.basis, 'SET_COMPOSITION', selected)
  );
};

const configurationIsProven = (quantity: ReadyQuantity): boolean => {
  const selected = quantity.selection.configuration;
  if (selected === undefined) {
    return true;
  }
  const { basis } = quantity.evidence;
  return (
    hasBasis(basis, 'CONFIGURATION_DEFINITION', selected.definition) &&
    selected.choices.every(
      (choice) =>
        (choice.attributeDefinition === undefined ||
          hasBasis(basis, 'ATTRIBUTE_DEFINITION', choice.attributeDefinition)) &&
        (choice.unit === undefined || hasBasis(basis, 'UNIT', choice.unit)),
    )
  );
};

/** Requires owner-issued exact facts already prepared for acceptance; never resolves Current or substitutes successors. */
export const prepareCatalogAcceptedSelectionHandoff = (input: HandoffInput): CatalogAcceptedSelectionHandoffResult => {
  const { quantity } = input;
  if (quantity.status !== 'READY') {
    return { reason: 'Current quantity handoff is not ready', status: 'UNVERIFIABLE' };
  }
  if (input.product === undefined || input.variant === undefined) {
    return { reason: 'Owner-issued Product and Variant historical values are required', status: 'UNVERIFIABLE' };
  }
  const { evidence, selection } = quantity;
  if (
    input.purpose.length === 0 ||
    input.purpose !== evidence.purpose ||
    !sameSelection(selection, evidence.selection)
  ) {
    return { reason: 'Acceptance purpose or exact selection differs from owner evidence', status: 'UNVERIFIABLE' };
  }
  if (
    !sameRef(input.product.reference.resourceRef, selection.productRef) ||
    !sameRef(input.variant.reference.resourceRef, selection.variantRef) ||
    !sameRef(input.variant.productRef, selection.productRef) ||
    !sameCatalogRevisionReference(input.variant.reference, evidence.membership.variant)
  ) {
    return {
      reason: 'Retained Product or Variant does not match owner-issued selection evidence',
      status: 'UNVERIFIABLE',
    };
  }
  const { basis } = evidence;
  if (!hasBasis(basis, 'PRODUCT', input.product.reference) || !hasBasis(basis, 'VARIANT', input.variant.reference)) {
    return { reason: 'Exact Product and Variant basis revisions are required', status: 'UNVERIFIABLE' };
  }
  if (!packageIsProven(quantity)) {
    return { reason: 'Exact Package Content and owner basis are required', status: 'UNVERIFIABLE' };
  }
  if (!setIsProven(quantity, input.setComposition)) {
    return { reason: 'Exact Set Composition, components, and owner basis are required', status: 'UNVERIFIABLE' };
  }
  if (!configurationIsProven(quantity)) {
    return {
      reason: 'Exact Configuration Definition and applicable Attribute Definition and Unit owner basis are required',
      status: 'UNVERIFIABLE',
    };
  }
  const handoff: CatalogAcceptedSelectionHandoff = {
    acceptedAt: input.acceptedAt,
    basis,
    historical: true,
    product: input.product,
    purpose: input.purpose,
    quantity: quantity.quantity,
    selection,
    variant: input.variant,
  };
  if (quantity.packageRevision !== undefined && quantity.packageContent !== undefined) {
    Object.assign(handoff, { packageContent: quantity.packageRevision, packageResolution: quantity.packageContent });
  }
  if (input.setComposition !== undefined) {
    Object.assign(handoff, { setComposition: input.setComposition });
  }
  return { handoff: structuredClone(handoff), status: 'ACCEPTED' };
};
