/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { ICellData, IExtendedAttrs } from 'common/Types';
import { stringFromCodePoint } from 'common/input/TextDecoder';
import { AttributeData, ExtendedAttrs } from 'common/buffer/AttributeData';

/**
 * CellData - represents a single Cell in the terminal buffer.
 */
export class CellData extends AttributeData implements ICellData {
  /**
   * Packed content layout (uint32):
   *  - bits 0..20: UTF-32 codepoint (0..0x10FFFF)
   *  - bit 21:     combined flag (string stored in BufferLine._combined)
   *  - bits 22..23: wcwidth (0..2), stored as unsigned integer
   */
  private static readonly _codepointMask   = 0x1FFFFF;
  private static readonly _isCombinedMask  = 0x200000; // 1 << 21
  private static readonly _hasContentMask  = 0x3FFFFF; // codepoint | combined
  private static readonly _widthMask       = 0xC00000; // 3 << 22
  private static readonly _widthShift      = 22;

  /** Extractors and packer for content field. */
  public static width(content: number): number { return content >>> CellData._widthShift; }
  public static hasContent(content: number): boolean { return !!(content & CellData._hasContentMask); }
  public static isCombined(content: number): boolean { return !!(content & CellData._isCombinedMask); }
  public static codepoint(content: number): number { return content & CellData._codepointMask; }
  public static packContent(codepoint: number, combined: boolean, width: number): number {
    return (combined ? CellData._isCombinedMask : codepoint) | (width << CellData._widthShift);
  }

  /** Helper for test function to create CellData from CharData. */
  public static fromCharData(value: [fg: number, chars: string, width: number, _code?: number]): CellData {
    const [fg, chars, width] = value;
    const obj = new CellData();
    obj.fg = fg;
    obj.bg = 0;
    obj.setChars(chars, width);
    return obj;
  }

  /** Primitives from terminal buffer. */
  public content = 0;
  public fg = 0;
  public bg = 0;
  public extended: IExtendedAttrs = new ExtendedAttrs();
  public combinedData = '';
  /** Whether cell contains a combined string. */
  public isCombined(): boolean {
    return CellData.isCombined(this.content);
  }
  /** Width of the cell. */
  public getWidth(): number {
    return CellData.width(this.content);
  }
  /** JS string of the content. */
  public getChars(): string {
    if (this.isCombined()) {
      return this.combinedData;
    }
    const cp = CellData.codepoint(this.content);
    return cp ? stringFromCodePoint(cp) : '';
  }
  /**
   * Codepoint of cell
   * Note this returns the UTF32 codepoint of single chars,
   * if content is a combined string it returns the codepoint
   * of the last char in string to be in line with code in CharData.
   */
  public getCode(): number {
    return (this.isCombined())
      ? this.combinedData.charCodeAt(this.combinedData.length - 1)
      : CellData.codepoint(this.content);
  }
  /** Encode content from string and width. */
  public setChars(chars: string, width: number): void {
    this.combinedData = '';
    let combined = false;
    // surrogates and combined strings need special treatment
    if (chars.length > 2) {
      combined = true;
    }
    else if (chars.length === 2) {
      const code = chars.charCodeAt(0);
      // if the 2-char string is a surrogate create single codepoint
      // everything else is combined
      if (0xD800 <= code && code <= 0xDBFF) {
        const second = chars.charCodeAt(1);
        if (0xDC00 <= second && second <= 0xDFFF) {
          const cp = ((code - 0xD800) * 0x400) + (second - 0xDC00) + 0x10000;
          this.content = CellData.packContent(cp, false, width);
        }
        else {
          combined = true;
        }
      }
      else {
        combined = true;
      }
    }
    else if (chars.length === 1) {
      this.content = CellData.packContent(chars.charCodeAt(0), false, width);
    }
    else { // empty string
      this.content = CellData.packContent(0, false, width);
    }
    if (combined) {
      this.combinedData = chars;
      this.content = CellData.packContent(0, true, width);
    }
  }
}
