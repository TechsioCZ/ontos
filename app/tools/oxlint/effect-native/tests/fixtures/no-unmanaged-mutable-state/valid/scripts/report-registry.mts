// `scripts/**` is excluded by default (`includeScripts: false`): audit B3 migrates only the
// consequential operational scripts.
const failures: string[] = [];
const identityCache = new WeakMap<object, string>();
let exitCode = 0;

export const fail = (message: string, owner: object): void => {
	failures.push(message);
	identityCache.set(owner, message);
	exitCode = 1;
};
