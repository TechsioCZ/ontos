// expect-count: 5
import { setTimeout as delay } from 'node:timers/promises';
import * as timers from 'node:timers';

export async function waitAndPoll(): Promise<void> {
	await delay(50);
	const handle = timers.setInterval(() => {}, 100);
	timers.clearInterval(handle);
}
