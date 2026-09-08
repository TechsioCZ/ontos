import { Effect } from 'effect';

interface Scheduler {
	readonly setTimeout: (callback: () => void, millis: number) => number;
}

export function run(scheduler: Scheduler, setTimeout: (callback: () => void) => void): void {
	setTimeout(() => {});
	scheduler.setTimeout(() => {}, 10);
}

export function withLocalBinding(): void {
	const setInterval = (callback: () => void) => callback();
	setInterval(() => {});
}

export const gen = Effect.gen(function* () {
	yield* Effect.void;
});
