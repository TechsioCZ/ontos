#!/usr/bin/env node
/* eslint-disable no-await-in-loop, complexity -- The provisioning script walks tenants in order. */

export const run = async (xs: readonly number[]): Promise<void> => {
	for (const x of xs) {
		await Promise.resolve(x);
	}
};
