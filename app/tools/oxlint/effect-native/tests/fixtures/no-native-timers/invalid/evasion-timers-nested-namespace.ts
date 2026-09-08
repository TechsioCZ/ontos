// expect-count: 3
import timers from 'node:timers';

declare const fn: () => void;

/** `node:timers` re-exports its own `promises` namespace, so the calls sit one member deeper. */
export async function boot(): Promise<void> {
	await timers.promises.setTimeout(5);
	timers.promises.setInterval(fn, 5);
}
