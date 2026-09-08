// D tier: `JSON.stringify` inside external test fixture APIs that require a body string.
export const postFixture = async (): Promise<string> => {
	const response = await fetch("/api/contacts", {
		method: "POST",
		body: JSON.stringify({ name: "Ada Lovelace" }),
	});
	return JSON.stringify(await response.json());
};
