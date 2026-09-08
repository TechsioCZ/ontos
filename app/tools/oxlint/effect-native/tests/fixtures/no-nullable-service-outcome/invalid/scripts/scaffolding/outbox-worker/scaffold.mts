// expect-count: 2
export interface Mutation {
	readonly mutationId: string;
}

export const loadMutation = async (mutationId: string): Promise<Mutation | undefined> => {
	void mutationId;
	return undefined;
};

export async function nextMutation(): Promise<Mutation | null> {
	return null;
}
