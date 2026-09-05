// A3: `await import("node:process")` reaches the same ambient bag as a static import.
export const Panel = async () => {
	const { env } = await import("node:process");
	const region = (await import("process")).env["REGION"];
	return <span data-region={region}>{env["TENANT"]}</span>;
};
