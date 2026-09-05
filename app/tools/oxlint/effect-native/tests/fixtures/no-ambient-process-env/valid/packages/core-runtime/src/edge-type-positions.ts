// Type-only references to the environment shape are legal: nothing is read at runtime.
import type { Config } from "effect";

export type Env = typeof process.env;
export type NodeEnv = (typeof process.env)["NODE_ENV"];
export type ProcessEnv = import("node:process").ProcessEnv;

export interface Ambient {
	readonly env: Record<string, string | undefined>;
	readonly process: { readonly env: Record<string, string | undefined> };
}

export type Loader<E extends Env = Env> = (source: E) => string;

export declare const AppConfig: Config.Config<{ readonly databaseUrl: string }>;

const descriptor = { kind: "config" } as const satisfies { readonly kind: string };
export const kind = descriptor.kind;
