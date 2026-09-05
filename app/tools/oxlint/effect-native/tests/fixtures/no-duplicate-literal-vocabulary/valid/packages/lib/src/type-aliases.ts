// TypeScript literal union aliases belong to the sibling `no-literal-union-type-alias` finding.
import { Schema } from 'effect';

export type PrincipalStatus = 'active' | 'disabled' | 'archived';
export type MirroredStatus = 'active' | 'disabled' | 'archived';

export interface PrincipalRow {
  readonly status: 'active' | 'disabled' | 'archived';
  readonly previous: 'active' | 'disabled' | 'archived';
}

export const Row = Schema.Struct({ status: Schema.String });
