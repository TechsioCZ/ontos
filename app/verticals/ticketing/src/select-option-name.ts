export const normalizeSelectOptionName = (name: string): string =>
  name.trim().normalize('NFC').toLocaleLowerCase('und');
