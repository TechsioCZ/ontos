// Splits the encoded AKROS baseline into insert parts for the in-app demo reset (see generate-akros-baseline.mts).
import { Effect, Schema } from 'effect';
import { ProductSchema, StockMovementSchema } from '../shared/domain/merchandise-model.ts';
import type { AkrosEncodedState } from './akros-baseline.ts';

type Movement = AkrosEncodedState['movements'][number];
type BaselineHeader = { -readonly [Key in 'categories' | 'homepageFeaturedProductIds']?: AkrosEncodedState[Key] };
interface BaselineChunk {
  movements: Movement[];
  products: AkrosEncodedState['products'][number][];
  size: number;
}
const encodeProduct = Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(ProductSchema)));
const encodeMovements = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.toEncoded(StockMovementSchema))));

/** Products (with their variants) per part stop growing past this many JSON characters. */
const PART_CHARACTERS = 600_000;

/**
 * Part 0: categories, orders, homepage selection and movements of no product. Every further part: consecutive
 * products with all of their movements (stock levels derive from them), in catalog and ledger order.
 */
export const akrosBaselineParts = Effect.fn('Akros.partitionBaseline')(function* partitionBaseline(
  state: AkrosEncodedState,
): Effect.fn.Return<readonly AkrosEncodedState[], Schema.SchemaError> {
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
  const header: BaselineHeader = {};
  if (state.categories !== undefined) {
    header.categories = state.categories;
  }
  if (state.homepageFeaturedProductIds !== undefined) {
    header.homepageFeaturedProductIds = state.homepageFeaturedProductIds;
  }
  const parts: AkrosEncodedState[] = [{ ...header, movements: orphanMovements, orders: state.orders, products: [] }];
  let current: BaselineChunk = {
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
  yield* Effect.forEach(
    state.products,
    Effect.fn(function* appendProduct(product: AkrosEncodedState['products'][number]) {
      const movements = movementsOf.get(product.id) ?? [];
      const [productJson, movementsJson] = yield* Effect.all([encodeProduct(product), encodeMovements(movements)], {
        concurrency: 1,
      });
      const size = productJson.length + movementsJson.length;
      if (current.size > 0 && current.size + size > PART_CHARACTERS) {
        flush();
      }
      current.products.push(product);
      current.movements.push(...movements);
      current.size += size;
    }),
    { concurrency: 1, discard: true },
  );
  flush();
  return parts;
});
