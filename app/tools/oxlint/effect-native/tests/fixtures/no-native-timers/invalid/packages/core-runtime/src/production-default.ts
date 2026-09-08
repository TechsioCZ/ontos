// expect-count: 1
export const schedule = (work: () => void) => setTimeout(work, 50);
