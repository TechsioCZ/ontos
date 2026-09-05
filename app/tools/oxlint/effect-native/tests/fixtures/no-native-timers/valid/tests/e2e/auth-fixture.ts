import { setTimeout as delay } from 'node:timers/promises';

/** D tier: Playwright/e2e drivers are Promise-and-timer shaped by construction. */
export async function waitForRedirect(): Promise<void> {
	await delay(250);
}
