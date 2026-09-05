// expect-count: 1
export const boom = (): never => {
	throw new Error("an .mts module is still Effect application code");
};
