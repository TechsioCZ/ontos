// expect-count: 5
// Top-level `await` inside class heritage, computed keys, `using` and decorators.
export {};

declare const base: () => Promise<new () => object>;
declare const decorate: () => Promise<(target: unknown) => void>;
declare const key: () => Promise<string>;
declare const open: () => Promise<Disposable>;

class Sub extends (await base()) {}
class Keyed {
	[await key()](): void {}
}
const record = { [await key()]: 1 };
using resource = await open();

@(await decorate())
class Decorated {}

void Sub;
void Keyed;
void record;
void resource;
void Decorated;
