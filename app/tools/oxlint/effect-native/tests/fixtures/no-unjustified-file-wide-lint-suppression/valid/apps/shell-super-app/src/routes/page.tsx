// Line-scoped waivers are exactly the "single outer framework adapter seam" the audit preserves.
export const Page = (): JSX.Element => {
	// oxlint-disable-next-line promise/prefer-await-to-then -- React effect callback must stay synchronous.
	void Promise.resolve().then(() => undefined);
	void Promise.resolve().then(() => undefined); // eslint-disable-line promise/prefer-await-to-then -- Framework adapter seam.
	return <div>page</div>;
};
