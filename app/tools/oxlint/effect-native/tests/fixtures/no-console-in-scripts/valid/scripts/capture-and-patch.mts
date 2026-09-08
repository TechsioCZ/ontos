// Audit/source correction: Sink assignment and vendor patch/restore do not emit diagnostic output (audit D). log forwarding is successful output; opaque handoff cannot prove a failure sink.
function makeReporter(sink: unknown): unknown {
	return sink;
}

const originalConsoleLog = console.log;

console.log = (...values: readonly unknown[]): void => {
	originalConsoleLog(...values);
};

export function restore(): void {
	console.log = originalConsoleLog;
}

export function handOffSink(): unknown {
	return makeReporter(console);
}
