declare const clock: { readonly setTimeout: (callback: () => void, millis: number) => void };
declare const timerName: string;
declare const registry: Record<string, (callback: () => void) => void>;

export function schedule(callback: () => void): void {
	clock.setTimeout(callback, 5);
	registry[timerName](callback);
}
