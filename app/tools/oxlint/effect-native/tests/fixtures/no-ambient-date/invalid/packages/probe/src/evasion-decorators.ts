// expect-count: 1
/** Decorated class member: parse probe plus the ambient clock inside it. */
const audited = (target: unknown, key: string): void => {
	void target;
	void key;
};

export class ClockReader {
	@audited
	read(): number {
		return new Date().valueOf();
	}
}
