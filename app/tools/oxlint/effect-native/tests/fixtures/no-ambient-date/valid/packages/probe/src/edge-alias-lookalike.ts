/** Aliases that do *not* resolve to a global must stay silent. */
class FakeClock {
	now(): number {
		return 0;
	}
}

const registry = { Date: FakeClock, performance: new FakeClock() };

/** Alias of a plain property, not of the global. */
const RegistryDate = registry.Date;
const registryPerformance = registry.performance;
export const clock = new RegistryDate();
export const millis = registryPerformance.now();

/** Alias of a locally declared binding that merely shares the global's name. */
const performance = { now: (): number => 1 };
const aliasedPerformance = performance;
export const elapsed = aliasedPerformance.now();

/** Destructuring something that is not a global. */
const { now } = registry.performance;
export const viaDestructure = now();

/** A property named like the global root does not make its members global. */
const host = { globalThis: registry };
export const nested = new host.globalThis.Date();
