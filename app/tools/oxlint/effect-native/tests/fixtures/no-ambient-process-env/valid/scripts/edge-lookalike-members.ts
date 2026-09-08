// `.env` members that are not the ambient environment, and `process.env` that is only text.
import * as process from "./shims/process.ts";
import { env } from "./config.ts";

declare const config: { readonly process: { readonly env: Record<string, string> } };

export const fromShim = process.env["A"];
export const fromConfig = config.process.env["B"];
export const fromModule = env["C"];

export const documentation = "process.env.DATABASE_URL is forbidden";
export const generated = `const url = process.env["DATABASE_URL"];`;
export const pattern = /process\.env\.[A-Z_]+/gu;

export class Holder {
	readonly env: Record<string, string> = {};
	read(key: string): string | undefined {
		return this.env[key];
	}
}
