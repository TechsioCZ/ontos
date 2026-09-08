/** .tsx is the framework adapter surface (includeTsx: false). */
export const loader = async () => await Promise.resolve({ ok: true });

export interface PageProps {
	readonly onSave: () => Promise<void>;
}
