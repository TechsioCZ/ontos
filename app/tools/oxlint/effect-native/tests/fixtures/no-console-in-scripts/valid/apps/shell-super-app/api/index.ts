// Outside scripts/**: production logging is already structured; this rule does not apply there.
export function bootLog(message: string): void {
	console.info(message);
	process.stdout.write(`${message}\n`);
}
