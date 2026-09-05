/** Zero-length quasis must not spin, crash, or report. */
export const empty = ``;

export const passthrough = (value: string): string => `${value}`;

export const joined = (left: string, right: string): string => `${left}${right}`;
