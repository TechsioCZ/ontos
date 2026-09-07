// expect-count: 1
export const loader = async () => await Promise.resolve({ ok: true });

export interface PageProps {
	readonly onSave: () => Promise<void>;
}
