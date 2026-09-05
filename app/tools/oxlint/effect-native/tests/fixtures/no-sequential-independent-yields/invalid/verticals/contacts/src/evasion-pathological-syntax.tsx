// expect-count: 2
// Evasion probe / crash probe: type-only import, ambient module declaration, explicit call type
// arguments, namespaced JSX, array holes and object rest in the binding patterns.
import type { Effect as EffectType } from "effect";
import { Effect } from "effect";

export type Program = EffectType.Effect<never>;

declare module "virtual:contacts" {
	export const marker: number;
}

declare const repository: { readonly readCustomer: <A>(id: A) => Effect.Effect<string> };
declare const ares: { readonly readSubject: (ico: string) => Effect.Effect<string> };

export const load = Effect.gen(function* () {
	const customer = yield* repository.readCustomer<string>("a");
	const subject = yield* ares.readSubject("b")! as unknown as string;
	return <svg:rect data-v={customer + subject} />;
});

export const patterns = Effect.gen(function* () {
	const [, customer] = yield* repository.readCustomer("a") as never;
	const { ...subject } = yield* ares.readSubject("b") as never;
	return { customer, subject };
});
