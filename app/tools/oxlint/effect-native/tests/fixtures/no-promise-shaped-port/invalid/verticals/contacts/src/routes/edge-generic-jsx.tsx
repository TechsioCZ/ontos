// expect-count: 2
const identity = <T,>(value: T): T => value;

export interface PageProps {
	readonly onSave: () => Promise<void>;
}

export const loadPage = async (): Promise<PageProps> => await Promise.resolve({ onSave: async () => {} });

export const Page = ({ onSave }: PageProps) => (
	<>
		<button onClick={() => void onSave()}>{identity("save")}</button>
	</>
);
