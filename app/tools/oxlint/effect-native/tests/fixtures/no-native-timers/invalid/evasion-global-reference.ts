declare const fn: () => void;

/** The timer is never a direct callee: it is aliased, comma-sequenced and passed as a callback. */
const later = setTimeout;

export function boot(): void {
	later(fn, 0);
	(0, setInterval)(fn, 10);
	void Promise.resolve().then(queueMicrotask);
}
