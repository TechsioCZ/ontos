/** A property that merely shares a global's name is not the global. */
class FakeClock {
	now(): number {
		return 0;
	}
}

const registry = { Date: FakeClock, performance: new FakeClock() };

export const clock = new registry.Date();
export const millis = registry.performance.now();
