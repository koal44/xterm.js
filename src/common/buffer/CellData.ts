/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { ICellData, IExtendedAttrs } from 'common/Types';
import { stringFromCodePoint } from 'common/input/TextDecoder';
import { Content } from 'common/buffer/Constants';
import { AttributeData, ExtendedAttrs } from 'common/buffer/AttributeData';

/**
 * CellData - represents a single Cell in the terminal buffer.
 */
export class CellData extends AttributeData implements ICellData {
  /** Helper for test function to create CellData from CharData. */
  public static fromCharData(value: [fg: number, chars: string, width: number, _code?: number]): CellData {
    const [fg, chars, width] = value;
    const obj = new CellData();
    obj.fg = fg;
    obj.bg = 0;
    obj.encodeContent(chars, width);
    return obj;
  }
  /** Primitives from terminal buffer. */
  public content = 0;
  public fg = 0;
  public bg = 0;
  public extended: IExtendedAttrs = new ExtendedAttrs();
  public combinedData = '';
  /** Whether cell contains a combined string. */
  public isCombined(): number {
    return this.content & Content.IS_COMBINED_MASK;
  }
  /** Width of the cell. */
  public getWidth(): number {
    return this.content >> Content.WIDTH_SHIFT;
  }
  /** JS string of the content. */
  public getChars(): string {
    if (this.content & Content.IS_COMBINED_MASK) {
      return this.combinedData;
    }
    if (this.content & Content.CODEPOINT_MASK) {
      return stringFromCodePoint(this.content & Content.CODEPOINT_MASK);
    }
    return '';
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
      : this.content & Content.CODEPOINT_MASK;
  }
  /** Encode content from string and width. */
  public encodeContent(chars: string, width: number): void {
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
          this.content = ((code - 0xD800) * 0x400 + second - 0xDC00 + 0x10000) | (width << Content.WIDTH_SHIFT);
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
      this.content = chars.charCodeAt(0) | (width << Content.WIDTH_SHIFT);
    }
    else { // empty string
      this.content = 0 | (width << Content.WIDTH_SHIFT);
    }
    if (combined) {
      this.combinedData = chars;
      this.content = Content.IS_COMBINED_MASK | (width << Content.WIDTH_SHIFT);
    }
  }
}
