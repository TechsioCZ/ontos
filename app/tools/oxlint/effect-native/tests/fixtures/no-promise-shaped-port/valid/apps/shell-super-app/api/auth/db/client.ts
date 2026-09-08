/** allowPaths: the pg Pool driver edge really does own a Promise contract. */
export interface PoolClient {
	readonly end: () => Promise<void>;
	query(sql: string): Promise<readonly unknown[]>;
}

export const client = {
	end: async () => {
		await Promise.resolve();
	},
};
