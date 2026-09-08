// expect-count: 1
// A file-wide directive is file-wide from wherever it sits; burying it under code must not hide it.
export const before = 1;

/* oxlint-disable no-await-in-loop */

export async function after(xs: readonly number[]): Promise<void> {
	for (const x of xs) {
		await Promise.resolve(x);
	}
}
