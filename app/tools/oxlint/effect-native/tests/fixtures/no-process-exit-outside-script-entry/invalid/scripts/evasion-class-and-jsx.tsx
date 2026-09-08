// expect-count: 4
// Evasion probe: class property arrow, async generator method, TSX prop reference and an
// `as` cast between the process object and the member.
import { exit as bail } from "node:process";

const Stop = ({ onExit }: { onExit: () => void }) => <button onClick={onExit}>stop</button>;

export const Shutdown = () => <Stop onExit={process.exit} />;

export class Runner {
	readonly abort = (): void => {
		globalThis.process.exitCode = 3;
	};

	async *stream(): AsyncGenerator<number> {
		yield 1;
		bail(2);
	}

	halt(code: number): void {
		(process as typeof process).exit(code);
	}
}
