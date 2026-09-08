// D tier: Playwright forces a Promise adapter at the browser-driver seam.
import { Effect } from "effect";

declare const test: (name: string, body: (page: { goto: (url: string) => Promise<void> }) => Promise<void>) => void;
declare const seedTenant: Effect.Effect<string>;

test("logs in", async (page) => {
	const tenant = await Effect.runPromise(seedTenant);
	await page.goto(`/login?tenant=${tenant}`);
});
