// Every line-scoped form of the waiver: the "single outer adapter seam" the audit preserves.
/* eslint-disable-next-line typescript/no-non-null-assertion -- One adapter line owns the assertion. */
export const first = (v?: string): string => v!;
// oxlint-disable-next-line eslint/no-await-in-loop -- Plugin-qualified, still line-scoped.
export const second = async (v: number): Promise<number> => v;
export const third = (v?: string): string => v!; // eslint-disable-line typescript/no-non-null-assertion -- Framework adapter seam.
// @ts-expect-error -- The deliberately malformed cast is the subject of this fixture.
export const malformed: string = 1;
