// expect-count: 3
// B3 evidence shape: run-zerops-migrator exits from inside signal handlers.
import process from "node:process";

const server = { close: (done: () => void): void => done() };

process.once("SIGTERM", () => {
	server.close(() => process.exit(0));
});

process.on("SIGINT", function handleInterrupt(): void {
	process.exitCode = 130;
	process.kill(process.pid, "SIGINT");
});
