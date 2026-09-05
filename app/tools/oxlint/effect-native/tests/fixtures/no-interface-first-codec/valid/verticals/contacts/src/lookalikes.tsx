import { Effect } from "effect";

import { Schema } from "./local-schema.ts";

export interface LocalRow {
	readonly id: string;
}

// `Schema` here is a local module, not `effect`'s Schema namespace.
export const localRowSchema: Schema.Codec<LocalRow> = Schema.Struct({ id: Schema.String });

// Legitimate `satisfies` / `as const` contract checks the audit explicitly preserves.
export const routes = { home: "/", contacts: "/contacts" } as const;
export const config = { retries: 3 } satisfies { readonly retries: number };

export const Badge = (): JSX.Element => <span>{String(localRowSchema)}</span>;

export const program = Effect.succeed(routes);
