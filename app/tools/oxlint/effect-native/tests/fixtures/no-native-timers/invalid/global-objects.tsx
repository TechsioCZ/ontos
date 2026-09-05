// expect-count: 5
/** The same timers reached through `globalThis`/`window`/`global`, computed and optional forms. */
export function mount(): void {
	globalThis.setTimeout(() => {}, 10);
	window?.setInterval(() => {}, 10);
	globalThis['setImmediate'](() => {});
	global.queueMicrotask(() => {});
}

export const Widget = () => <div onClick={() => setTimeout(() => {}, 0)} />;
