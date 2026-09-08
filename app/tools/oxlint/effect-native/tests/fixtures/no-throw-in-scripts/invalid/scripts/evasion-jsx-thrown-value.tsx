// expect-count: 2
export function renderOrFail(ok: boolean): unknown {
	if (!ok) throw <div className="failure">render failed</div>;
	throw new Error();
}
