// expect-count: 1
import { Effect } from 'effect';

declare const log: (target: unknown, key: string, descriptor: PropertyDescriptor) => void;
declare const load: Effect.Effect<string>;

export class Service {
	@log
	read(): string {
		return Effect.runSync(load);
	}
}
