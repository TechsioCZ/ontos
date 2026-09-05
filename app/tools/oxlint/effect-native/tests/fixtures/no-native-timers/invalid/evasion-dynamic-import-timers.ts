/** The same node:timers sleep, reached through a dynamic import instead of a static one. */
export async function waitAndPoll(): Promise<void> {
	const { setTimeout: delay } = await import('node:timers/promises');
	await delay(50);
	const timers = await import('node:timers');
	timers.setInterval(() => {}, 100);
}
