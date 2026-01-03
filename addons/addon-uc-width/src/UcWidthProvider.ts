import { type IUnicodeVersionProvider } from '@xterm/xterm';
import { ucWidthOptions, ucWidthStep, type UcWidthState } from 'uc-width';
import { UnicodeService } from 'common/services/UnicodeService';

export class UcWidthProvider implements IUnicodeVersionProvider {
  private _opts = ucWidthOptions({ vs15: 2 });
  public readonly version = '17';

  public wcwidth(cp: number): 0 | 1 | 2 {
    // stateless wcwidth(cp) can't account for ZWJ/VS16/combining; it's here only
    // because the interface asked for it. For tests, measure strings via ucWidth(str)
    // instead of single codepoints.
    return ucWidthStep(cp, this._opts).clusterWidth;
  }

  public charProperties(cp: number, preceding: number): number {
    const inState = unpackState(preceding);
    const { shouldJoin, clusterWidth, state: nextState } = ucWidthStep(cp, this._opts, inState);
    const packedState = packState(nextState);

    return UnicodeService.createPropertyValue(packedState, clusterWidth, shouldJoin);
  }
}

type UInt1 = 0 | 1;
type UInt2 = 0 | 1 | 2 | 3;
type UInt4 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

// unpack helpers (mask on read)
const u1 = (x: number): boolean => (x & 0x1) !== 0;
const u2 = (x: number): UInt2   => (x & 0x3) as UInt2;
const u4 = (x: number): UInt4   => (x & 0xF) as UInt4;

// pack helpers (mask on write)
const p1 = (x: boolean): UInt1 => (x ? 1 : 0);
const p2 = (x: number): number => x & 0x3;
const p4 = (x: number): number => x & 0xF;

// 15-bit "char kind" layout (LSB -> MSB):
export function packState(state: UcWidthState): number {
  const { m, g } = state;

  let x = 0;
  x |= p1(m.canNarrowVs15)    << 0;
  x |= p1(m.canWidenVs16)     << 1;
  x |= p1(g.started)          << 2;
  x |= p1(g.riOdd)            << 3;
  x |= p2(g.epState)          << 4;
  x |= p2(g.incbState)        << 6;
  x |= p4(g.lastProps.gcb)    << 8;
  x |= p2(g.lastProps.incb)   << 12;
  x |= p1(g.lastProps.ep)     << 14;

  return x;
}

export function unpackState(prev: number): UcWidthState {
  const clusterWidth = UnicodeService.extractWidth(prev);
  const x = UnicodeService.extractCharKind(prev);

  const canNarrowVs15 = u1(x >>> 0);
  const canWidenVs16 =  u1(x >>> 1);
  const started =       u1(x >>> 2);
  const riOdd =         u1(x >>> 3);
  const epState =       u2(x >>> 4);
  const incbState =     u2(x >>> 6);
  const gcb =           u4(x >>> 8);
  const incb =          u2(x >>> 12);
  const ep =            u1(x >>> 14);

  if (!isGcb(gcb)) throw new Error(`Invalid gcb value in packed state: ${gcb}`);
  if (!isIncbState(incbState)) throw new Error(`Invalid incbState value in packed state: ${incbState}`);

  return {
    clusterWidth,
    m: { canNarrowVs15, canWidenVs16 },
    g: {
      started,
      lastProps: { gcb, incb, ep },
      riOdd,
      epState,
      incbState,
    },
  };
}

type IncbState = UcWidthState['g']['incbState'];
type Gcb = UcWidthState['g']['lastProps']['gcb'];

function isGcb(x: number): x is Gcb {
  return x >= 0 && x <= 13;
}

function isIncbState(x: number): x is IncbState {
  return x >= 0 && x <= 2;
}
