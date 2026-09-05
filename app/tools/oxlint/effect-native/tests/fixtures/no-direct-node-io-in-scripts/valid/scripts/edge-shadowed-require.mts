// Every `require`-looking callee here is a local binding, not CommonJS `require`.
import * as FileSystem from "effect/FileSystem";

export function loadWith(require: (specifier: string) => unknown): unknown {
	return require("node:fs");
}

const localRequire = (specifier: string): string => specifier;
export const fake = localRequire("node:child_process");

class Loader {
	private readonly require = (specifier: string): string => specifier;

	load(): string {
		return this.require("node:fs");
	}
}

export const loader = new Loader().load();
export const service = FileSystem.FileSystem;
