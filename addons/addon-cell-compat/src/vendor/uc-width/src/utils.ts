export function hexToStr(n?: number[] | number, prefix = '0x'): string {
  if (n === undefined) return 'undefined';
  if (Array.isArray(n)) {
    return `[${n.map((x) => hexToStr(x, prefix)).join(', ')}]`;
  }

  const hex = n.toString(16);
  const padded = hex.length >= 4 ? hex : ('0000' + hex).slice(-4);
  return `${prefix}${padded}`;
}

export function binToStr(n: number, width: number): string {
  let s = (n >>> 0).toString(2);
  if (s.length < width) s = '0'.repeat(width - s.length) + s;
  // group as 4-bit nibbles
  return s.replace(/(.{4})/g, '$1_').replace(/_$/, '');
}
