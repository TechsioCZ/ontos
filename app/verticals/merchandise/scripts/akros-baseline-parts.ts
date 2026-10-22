// Splits the encoded AKROS baseline into insert parts for the in-app demo reset (see generate-akros-baseline.mts).
import type { AkrosEncodedState } from './akros-baseline.ts';

type Movement = AkrosEncodedState['movements'][number];

/** Products (with their variants) per part stop growing past this many JSON characters. */
const PART_CHARACTERS = 600_000;

/**
 * Part 0: categories, orders, homepage selection and movements of no product. Every further part: consecutive
 * products with all of their movements (stock levels derive from them), in catalog and ledger order.
 */
export const akrosBaselineParts = (state: AkrosEncodedState): readonly AkrosEncodedState[] => {
  const productIds = new Set(state.products.map((product) => product.id));
  const movementsOf = new Map<string, Movement[]>();
  const orphanMovements: Movement[] = [];
  for (const movement of state.movements) {
    if (!productIds.has(movement.productId)) {
      orphanMovements.push(movement);
      continue;
    }
    const bucket = movementsOf.get(movement.productId) ?? [];
    bucket.push(movement);
    movementsOf.set(movement.productId, bucket);
  }
  const parts: AkrosEncodedState[] = [
    {
      ...(state.categories === undefined ? {} : { categories: state.categories }),
      ...(state.homepageFeaturedProductIds === undefined
        ? {}
        : { homepageFeaturedProductIds: state.homepageFeaturedProductIds }),
      movements: orphanMovements,
      orders: state.orders,
      products: [],
    },
  ];
  let current: { movements: Movement[]; products: AkrosEncodedState['products'][number][]; size: number } = {
    movements: [],
    products: [],
    size: 0,
  };
  const flush = () => {
    if (current.products.length > 0) {
      parts.push({ movements: current.movements, orders: [], products: current.products });
    }
    current = { movements: [], products: [], size: 0 };
  };
  for (const product of state.products) {
    const movements = movementsOf.get(product.id) ?? [];
    const size = JSON.stringify(product).length + JSON.stringify(movements).length;
    if (current.size > 0 && current.size + size > PART_CHARACTERS) {
      flush();
    }
    current.products.push(product);
    current.movements.push(...movements);
    current.size += size;
  }
  flush();
  return parts;
};
