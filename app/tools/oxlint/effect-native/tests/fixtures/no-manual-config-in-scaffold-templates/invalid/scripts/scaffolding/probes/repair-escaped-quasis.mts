// expect-count: 3
export const source = `const label = "😀";\nconst config = JSON.parse(rawConfig);`;
export const repeated = `const label = "😀"; const first = JSON.parse(rawConfig); const second = JSON.parse(rawConfig);`;
