/** D tier: a body serialised into the browser page has no Effect runtime, Clock or TestClock. */
declare const page: {
	readonly evaluate: <T>(body: () => T) => Promise<T>;
	readonly waitForFunction: (predicate: () => boolean) => Promise<void>;
	readonly $eval: <T>(selector: string, body: (element: Element) => T) => Promise<T>;
};

export const hydrationWait = async (): Promise<number> => {
	await page.waitForFunction(() => performance.now() > 0);
	await page.$eval("form", (element) => element.getAttribute("data-hydrated-at"));
	return await page.evaluate(() => new Date().getTime() - Date.now());
};
