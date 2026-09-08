// expect-count: 5
// Decorators, tagged templates, JSX children/attributes and nested arrow bodies.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;
declare const tag: (strings: TemplateStringsArray, ...values: unknown[]) => string;
declare function deco(...args: unknown[]): ClassDecorator;

@deco(Effect.runSync(program))
class Decorated {}

export const label = tag`value ${Effect.runSync(program)}`;

export default function Panel(): JSX.Element {
	return <section title={String(Effect.runSync(program))}>{Effect.runSync(program)}</section>;
}

export const nested = <A,>(value: A): A =>
	((): A => {
		void Effect.runFork(program);
		return value;
	})();

export const keep = Decorated;
