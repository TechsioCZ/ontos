// expect-count: 2
export function assertRole(role: string): string {
	if (role === "") throw new Error("role is required");
	if (role === "postgres") throw new RangeError("runtime role must not be the superuser");
	return role;
}
