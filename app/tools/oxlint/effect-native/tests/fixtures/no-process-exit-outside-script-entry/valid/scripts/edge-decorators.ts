// Crash probe: decorators in a script file.
const logged = (target: unknown, key: string): void => {
	void target;
	void key;
};

export class Deployer {
	@logged
	deploy(): void {
		console.log("deploy");
	}
}
