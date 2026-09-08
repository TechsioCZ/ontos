// expect-count: 2
// Evasion: the global constructor is captured in a module-level alias one hop before `new`.
// The side channel is identical to A4's `transactionFailureCauses` WeakMap.
const IdentityChannel = WeakMap;
const ProvenanceRegistry = WeakSet;

export const transactionFailureCauses = new IdentityChannel<Error, unknown>();
export const trustedSystemContexts = new ProvenanceRegistry<object>();

export const attachCause = (error: Error, cause: unknown): void => {
	transactionFailureCauses.set(error, cause);
};

export const trust = (context: object): void => {
	trustedSystemContexts.add(context);
};
