export const scope = async (open: () => AsyncDisposable): Promise<void> => {
	await using handle = open();
	void handle;
};
