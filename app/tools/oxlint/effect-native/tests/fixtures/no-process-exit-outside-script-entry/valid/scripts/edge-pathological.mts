// Crash probe: exotic syntax around the names this rule matches — a side-effect-only process
// import, a re-export, a class with a private field and an inherited method named `exit`,
// a label, non-literal computed access, an argument-less kill and a spread kill.
import "node:process";

export { exit } from "node:process";

const key: string = "exit";

class Base {
	exit(): void {}
}

export class Child extends Base {
	#exitCode = 0;

	override exit(): void {
		super.exit();
		this.#exitCode += 1;
	}

	get exitCode(): number {
		return this.#exitCode;
	}
}

export const noisy = (pids: readonly number[]): void => {
	exitLabel: for (const pid of pids) {
		if (pid === 0) break exitLabel;
		process.kill(pid, "SIGTERM");
	}
	process.kill(...pids);
	void process[key];
	void `process.exit(1)`;
};
