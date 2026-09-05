// Type-only imports of the process module are erased at runtime: nothing reads the environment.
import type { env } from "node:process";
import { type env as ambientEnv } from "process";

export type AmbientEnv = typeof env;
export type AliasedEnv = typeof ambientEnv;

export interface Ports {
	readonly environment: AmbientEnv;
}

export const keys = (ports: Ports): readonly string[] => Object.keys(ports.environment);
