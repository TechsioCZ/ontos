// expect-count: 7
/** Every global timer entry point: none of them is interruptible or driven by the Effect Clock. */
export function scheduleAbort(controller: AbortController, ms: number): void {
	const timer = setTimeout(() => controller.abort(), ms);
	const interval = setInterval(() => controller.abort(), ms);
	const immediate = setImmediate(() => controller.abort());
	queueMicrotask(() => controller.abort());
	clearTimeout(timer);
	clearInterval(interval);
	clearImmediate(immediate);
}
