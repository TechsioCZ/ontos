// False-positive probe: a type-only import of `exit` used only in a type position never
// terminates anything.
import type { exit } from "node:process";

export const describe = (): string => {
	type ExitFn = typeof exit;
	const fn: ExitFn | undefined = undefined;
	return typeof fn;
};
