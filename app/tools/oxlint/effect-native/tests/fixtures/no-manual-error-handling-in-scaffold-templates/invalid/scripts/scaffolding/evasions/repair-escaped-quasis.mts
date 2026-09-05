// expect-count: 3
export const source = `const label = "😀";\nconst classified = error._tag === 'Bad';`;
export const repeated = `const label = "😀"; const first = error._tag === 'Bad'; const second = error._tag !== 'Other';`;
