// Constructors reached through an injected container are not the ambient globals.
interface Deps {
	readonly Error: new (message: string) => object;
	readonly TypeError: new () => object;
}

export const fromDeps = (deps: Deps): object => new deps.Error("injected");

export const fromDepsComputed = (deps: Deps): object => new deps["TypeError"]();

const registry = { Error: class LocalError {} };

export const fromRegistry = (): object => new registry.Error();

export const notStackSurgery = (logger: { captureStackTrace(): void }): void => logger.captureStackTrace();

export function shadowedContainer(globalThis: Deps): object {
	return new globalThis.Error("the container itself is a parameter");
}
