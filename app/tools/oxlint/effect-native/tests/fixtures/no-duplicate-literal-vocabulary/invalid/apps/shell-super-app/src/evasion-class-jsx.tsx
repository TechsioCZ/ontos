// expect-count: 3
// Evasion: TSX file, BFF re-export barrel, class static field, JSX attribute and nested arrow body.
import { Schema } from '@modern-js/plugin-bff/effect-client';

export class ApiKeyContracts {
  static readonly BindingStatus = Schema.Literals(['active', 'disabled']);
  static readonly Patch = Schema.Struct({ newStatus: Schema.Literals(['disabled', 'active']) });
}

const Row = Schema.Struct({ status: Schema.Literals(['active', 'disabled']) });

export function StatusBadge() {
  const decode = () => Schema.Literals(['disabled', 'active']);
  return <span data-row={String(Row)} data-decode={String(decode())} />;
}
