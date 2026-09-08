// expect-count: 3
declare const fn: () => void;
interface TimerHost {
	readonly setInterval: (callback: () => void, millis: number) => number;
}

/** TS interop casts and non-null assertions hide the very same global timers. */
export function boot(): void {
	(globalThis as unknown as TimerHost).setInterval(fn, 10);
	(window as any).setTimeout(fn, 0);
	globalThis!.setImmediate(fn);
}
