declare const api: { readonly setTimeout: (callback: () => void) => void };

export class Timer {
	setTimeout(): void {}
	queueMicrotask(): void {}
}

export function boot(): void {
	api.setTimeout(() => {});
	new Timer().setTimeout();
	const Schedule = { spaced: (_: string) => 1 };
	Schedule.spaced('1 second');
	const local = { queueMicrotask: (callback: () => void) => callback() };
	local.queueMicrotask(() => {});
}
