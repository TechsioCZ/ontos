/** App source, not scripts/**: out of this rule's scope entirely. */
export function requirePort(raw: string | undefined): number {
	if (raw === undefined) throw new Error("PORT is required");
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port)) throw new SyntaxError("PORT must be an integer");
	return port;
}
