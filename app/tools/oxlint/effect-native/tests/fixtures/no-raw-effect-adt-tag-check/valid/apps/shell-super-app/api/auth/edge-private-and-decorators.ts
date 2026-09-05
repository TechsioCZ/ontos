import { Effect, Exit } from 'effect';

const audited = <T extends abstract new (...args: never[]) => object>(target: T, _context: ClassDecoratorContext): T =>
	target;

/** Decorators, `accessor`, static blocks and private `#_tag` fields must parse and stay unreported. */
@audited
export class Session {
	static readonly kind = 'session';
	readonly #_tag = 'Some';
	accessor label = 'session';

	get present(): boolean {
		return this.#_tag === 'Some';
	}

	check(exit: Exit.Exit<void>): Effect.Effect<string> {
		return Effect.sync(() => (Exit.isFailure(exit) ? 'failed' : 'ok'));
	}
}
