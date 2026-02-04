export function hexToStr(n?: number[] | number, prefix = '0x', padding = 4): string {
  if (n === undefined) return 'undefined';
  if (Array.isArray(n)) {
    return `[${n.map((x) => hexToStr(x)).join(', ')}]`;
  }
  return `${prefix}${n.toString(16).padStart(padding, '0')}`;
}

export function formatCodePoints(s: string): string {
  const cps: string[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    cps.push(`{${hexToStr(cp)}}`);
  }
  return cps.join('');
}

const UTF8 = new TextDecoder('utf-8', { fatal: false });
export function decodeData(data: unknown): string {
  let s: string;
  if (typeof data === 'string') {
    s = data;
  } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const u8 = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    s = UTF8.decode(u8);
  } else if (data instanceof Blob) {
    s = `<<blob:${data.size}B:${data.type || 'unknown'}>>`;
  } else {
    s = `<<unknown:${Object.prototype.toString.call(data)}>>`;
  }
  return s;
}

export function escapeForLog(s: string, opts: { zwj?: boolean } = {}): string {
  // Make control characters visible, plus ZWJ marker.
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if      (cp === 0x0d) out += '\\r';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x09) out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += `${hexToStr(cp, '\\x', 2)}`;
    else if (cp === 0x200D && opts.zwj) out += '{zwj}';
    else out += ch;
  }
  return out;
}
