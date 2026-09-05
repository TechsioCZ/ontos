// A `process` parameter, an `env` import from a non-process module, and a namespace import that
// only looks like the global are all ordinary bindings, not the ambient environment.
import { env } from "../support/environment.ts";
import * as process from "../support/fake-process.ts";

export function readFromInjectedProcess(process: { readonly env: Record<string, string> }): string {
	return process.env.HOME;
}

export const configuredUrl = env.DATABASE_URL;

export const stubbedHome = process.env.HOME;

export function readFromPort(port: { readonly get: (key: string) => string | undefined }): string | undefined {
	return port.get("DATABASE_URL");
}
