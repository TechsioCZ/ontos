// expect-count: 2
export function generate(name: string): string {
	if (name === "") throw new Error("name is required");
	if (name.includes("/")) throw new TypeError("name must not contain a slash");
	return name;
}
