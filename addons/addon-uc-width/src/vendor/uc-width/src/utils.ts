export function hexToStr(n?: number[] | number, prefix = '0x'): string {
  if (n === undefined) return 'undefined';
  if (Array.isArray(n)) {
    return `[${n.map((x) => hexToStr(x, prefix)).join(', ')}]`;
  }

  const hex = n.toString(16);
  const padded = hex.length >= 4 ? hex : ('0000' + hex).slice(-4);
  return `${prefix}${padded}`;
}
