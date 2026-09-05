import { mock } from 'node:test';

/** node:test virtual timers already make the native calls deterministic. */
export function withVirtualTimers(): void {
	mock.timers.enable({ apis: ['setTimeout'] });
	const handle = setTimeout(() => {}, 1000);
	mock.timers.tick(1000);
	clearTimeout(handle);
	mock.timers.reset();
}
