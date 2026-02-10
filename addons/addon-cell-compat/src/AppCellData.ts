/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IAttributeData, ICellData, IExtendedAttrs } from 'common/Types';
import { stringFromCodePoint } from 'common/input/TextDecoder';
import { AttributeData, ExtendedAttrs } from 'common/buffer/AttributeData';

/**
 * AppCellData - represents a single Cell in the terminal buffer.
 */
export class AppCellData extends AttributeData implements ICellData {
  /**
   * Packed content layout (uint32):
   *  - bits 0..20  : UTF-32 codepoint : (0..0x10FFFF) 0 => combined or "empty" cell
   *  - bit  21     : combined flag    : (0..1) 1 => chars stored out-of-band
   *  - bits 22..23 : appWidth         : (0..3) (wcwidth-aligned)
   *  - bits 24..25 : movWidth         : (0..3) 3 => width stored out-of-band
   *  - bits 26..27 : delWidth         : (0..3) 3 => width stored out-of-band
   *  - bits 28..29 : visWidth         : (0..3)
   *  - bit  30     : visJoin          : (0..1)
   *  - bit  31     : reserved         : (0)
   */
  private static readonly _codepointMask   = 0x001F_FFFF; // (1<<21)-1, bits 0..20
  private static readonly _isCombinedMask  = 0x0020_0000; // 1<<21
  private static readonly _appWidthShift   = 22;
  private static readonly _appWidthMask    = 0x00C0_0000; // 3<<22
  private static readonly _movWidthShift   = 24;
  private static readonly _movWidthMask    = 0x0300_0000; // 3<<24
  private static readonly _delWidthShift   = 26;
  private static readonly _delWidthMask    = 0x0C00_0000; // 3<<26
  private static readonly _visWidthShift   = 28;
  private static readonly _visWidthMask    = 0x3000_0000; // 3<<28
  private static readonly _visJoinShift    = 30;
  private static readonly _visJoinMask     = 0x4000_0000; // 1<<30
  private static readonly _reservedMask    = 0x8000_0000; // 1<<31 (must be 0)
  private static readonly _hasContentMask  = AppCellData._codepointMask | AppCellData._isCombinedMask;
  private static readonly _sideLoad        = 3;           // 0b11 sentinel for movWidth/delWidth when combined

  /** Extractors */
  public static hasContent(content: number): boolean { return !!(content & AppCellData._hasContentMask); }
  public static isCombined(content: number): boolean { return !!(content & AppCellData._isCombinedMask); }
  public static codepoint(content: number): number { return content & AppCellData._codepointMask; }
  public static appWidth(content: number): number { return (content & AppCellData._appWidthMask) >>> AppCellData._appWidthShift; }
  public static movWidth(content: number): number { return (content & AppCellData._movWidthMask) >>> AppCellData._movWidthShift; }
  public static delWidth(content: number): number { return (content & AppCellData._delWidthMask) >>> AppCellData._delWidthShift; }
  public static visWidth(content: number): number { return (content & AppCellData._visWidthMask) >>> AppCellData._visWidthShift; }
  public static visJoin(content: number): boolean { return !!(content & AppCellData._visJoinMask); }

  /** Packers */
  public static packContent(cp: number, combined: boolean, appWidth: number, movWidth: number, delWidth: number, visWidth: number, visJoin: boolean): number {
    const mw = movWidth <= 2 ? movWidth : AppCellData._sideLoad;
    const dw = delWidth <= 2 ? delWidth : AppCellData._sideLoad;
    const v =
      (combined ?  AppCellData._isCombinedMask : (cp & AppCellData._codepointMask)) |
      (appWidth << AppCellData._appWidthShift) |
      (mw       << AppCellData._movWidthShift) |
      (dw       << AppCellData._delWidthShift) |
      (visWidth << AppCellData._visWidthShift) |
      (+visJoin << AppCellData._visJoinShift);
    return v >>> 0;
  }

  private static _packCpCombined(codepoint: number, combined: boolean): number {
    return combined ? AppCellData._isCombinedMask : ((codepoint & AppCellData._codepointMask) >>> 0);
  }

  private static _cpCombinedBits(chars: string): number {
    const len = chars.length;

    if (len === 0) return AppCellData._packCpCombined(0, false);
    if (len === 1) return AppCellData._packCpCombined(chars.charCodeAt(0), false);

    if (len === 2) {
      const hi = chars.charCodeAt(0);
      if (hi >= 0xD800 && hi <= 0xDBFF) {
        const lo = chars.charCodeAt(1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          const cp = ((hi - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
          return AppCellData._packCpCombined(cp, false);
        }
      }
      return AppCellData._packCpCombined(0, true);
    }

    // len > 2 is always combined
    return AppCellData._packCpCombined(0, true);
  }

  public static from(chars: string, appWidth: number, movWidth: number, delWidth: number, visWidth: number, visJoin: boolean, attr?: IAttributeData): AppCellData {
    const obj = new AppCellData();
    const cpCombined = AppCellData._cpCombinedBits(chars);
    const cp = AppCellData.codepoint(cpCombined);
    const isCombined = AppCellData.isCombined(cpCombined);
    obj.combinedData = AppCellData.isCombined(cpCombined) ? chars : '';
    obj.sideloadMovWidth = movWidth > 2 ? movWidth : 0;
    obj.sideloadDelWidth = delWidth > 2 ? delWidth : 0;
    obj.content = AppCellData.packContent(cp, isCombined, appWidth, movWidth, delWidth, visWidth, visJoin);
    if (attr) {
      obj.fg = attr.fg;
      obj.bg = attr.bg;
      // obj.extended = attr.extended;
    }
    return obj;
  }

  /** Primitives from terminal buffer. */
  public content = 0;
  public fg = 0;
  public bg = 0;
  public extended: IExtendedAttrs = new ExtendedAttrs();
  public combinedData = '';
  public sideloadMovWidth = 0;
  public sideloadDelWidth = 0;

  /** Whether cell contains a combined string. */
  public isCombined(): boolean {
    return AppCellData.isCombined(this.content);
  }

  /** App width is the # of columns the backend app intends this cell to occupy. */
  public getWidth(): number {
    return AppCellData.appWidth(this.content);
  }

  /** Mov width is the # of arrow key presses to move over this cell. */
  public getMovWidth(): number {
    const mw = AppCellData.movWidth(this.content);
    return mw === AppCellData._sideLoad ? this.sideloadMovWidth : mw;
  }

  /** Del width is the # of backspace key presses to delete this cell. */
  public getDelWidth(): number {
    const dw = AppCellData.delWidth(this.content);
    return dw === AppCellData._sideLoad ? this.sideloadDelWidth : dw;
  }

  /** Vis width is the # of columns this cell occupies in our rendering. */
  public getVisWidth(): number {
    return AppCellData.visWidth(this.content);
  }

  /** Whether this cell is the root of a rendered cell. */
  public isVisJoin(): boolean {
    return AppCellData.visJoin(this.content);
  }

  /** JS string of the content. */
  public getChars(): string {
    if (this.isCombined()) {
      return this.combinedData;
    }
    const cp = AppCellData.codepoint(this.content);
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
      : AppCellData.codepoint(this.content);
  }
}
