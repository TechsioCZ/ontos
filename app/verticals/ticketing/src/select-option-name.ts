export interface PreparedSelectOptionName {
  readonly displayName: string;
  readonly normalizedName: string;
}

export const prepareSelectOptionName = (input: string): PreparedSelectOptionName => {
  const displayName = input.trim().normalize('NFC');

  return {
    displayName,
    normalizedName: displayName.toLocaleLowerCase('und'),
  };
};
