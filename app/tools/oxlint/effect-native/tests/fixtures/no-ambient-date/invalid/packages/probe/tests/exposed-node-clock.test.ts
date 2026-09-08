// expect-count: 1
// exposeFunction callbacks run in Node, unlike evaluate/waitForFunction page bodies.
declare const page: { exposeFunction(name: string, fn: () => number): Promise<void> };
await page.exposeFunction("hostNow", () => Date.now());
