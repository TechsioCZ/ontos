// expect-count: 1
// 30 nested transparent wrappers are still inside the walk budget.
export type Deep = Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<Readonly<{ readonly _tag: 'Deep' }>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>;
