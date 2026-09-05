import { Schema } from 'effect';

// Type references are not calls: a generated declaration surface must not report.
export interface ApiKeyShape {
  readonly expiresAt: Schema.NullOr<Schema.String>;
  readonly name: Schema.NullOr<Schema.String>;
}

export declare const KeySchema: Schema.NullOr<Schema.String>;

export type Wrapped = Schema.UndefinedOr<Schema.Finite>;
