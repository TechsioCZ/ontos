export const download = (href: string, name: string) => {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.click();
};
