// expect-count: 1
// The edge barrel re-exports Effect's `Schema` verbatim.
import { Schema } from '@modern-js/bff-effect/effect-edge';

export const CustomerListItem = Schema.Struct({
  status: Schema.Literals(['prospect', 'customer', 'former']),
});

export const CustomerDetail = Schema.Struct({
  status: Schema.Literals(['prospect', 'customer', 'former']),
});
