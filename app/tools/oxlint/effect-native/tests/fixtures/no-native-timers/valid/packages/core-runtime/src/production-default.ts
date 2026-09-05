export const schedule = (setTimeout: (work: () => void, delay: number) => void, work: () => void) => setTimeout(work, 50);
