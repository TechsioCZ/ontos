// expect-count: 9
// `as` / `satisfies` / assertion wrappers, default parameters, IIFEs and static blocks.
import { Effect } from "effect";

declare const consume: (handler: () => Promise<void>) => void;

const satisfied = (async (): Promise<void> => {}) satisfies () => Promise<void>;
const asserted = (async (): Promise<void> => {}) as () => Promise<void>;
const angled = <() => Promise<void>>(async (): Promise<void> => {});
function withDefault(callback: () => Promise<void> = async () => {}): void {
	void callback;
}
const make = () => async (): Promise<number> => 1;
void (async (): Promise<void> => {
	await Promise.resolve();
})();
class Boot {
	static {
		consume(async () => {});
	}
}
const wrapped = Effect.sync((async () => 1) as unknown as () => number);
const sibling = Effect.tryPromise({
	catch: String,
	extra: async () => 2,
	try: () => Promise.resolve(1),
} as never);

void satisfied;
void asserted;
void angled;
void withDefault;
void make;
void Boot;
void wrapped;
void sibling;
