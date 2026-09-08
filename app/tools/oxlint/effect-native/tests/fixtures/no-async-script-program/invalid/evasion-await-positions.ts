// expect-count: 10
// Top-level `await` hidden in expression positions a naive scan would miss.
import { Effect } from "effect";

declare const load: () => Promise<string>;
declare const tag: (strings: TemplateStringsArray, ...values: unknown[]) => string;
declare const client: { query?: () => Promise<number> } | undefined;
declare const cond: boolean;

const inTemplate = `${await load()}`;
const inTagged = tag`${await load()}`;
const inConditional = await (cond ? load() : load());
const inOptionalCall = await client?.query?.();
for (const value of await Promise.all([load()])) console.log(value);
switch (await load()) {
	default:
		break;
}
if (cond) throw await load();
console.log(...(await Promise.all([load()])));
const nonNull = await client!.query!();
const asserted = await (load() as Promise<string>);
console.log(inTemplate, inTagged, inConditional, inOptionalCall, nonNull, asserted);
void Effect.void;
