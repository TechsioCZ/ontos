// expect-count: 2
export type DeepParens = ((('dead') | (('pending') | ('stale'))));

export type VeryDeep = (((((((((('no' | 'yes'))))))))));
