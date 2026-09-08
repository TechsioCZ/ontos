// False-positive probe: writes to an `exitCode` that belongs to someone else.
interface Result {
	exitCode: number;
}

export const record = (result: Result, state: { exitCode: number }): void => {
	result.exitCode = 1;
	state.exitCode ||= 2;
	let exitCode = 0;
	exitCode += 1;
	void exitCode;
};
