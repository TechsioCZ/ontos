// B2 owns the test harness; test files never report.
export function captureOutput(message: string): void {
	console.log(message);
	process.stdout.write(`${message}\n`);
}
