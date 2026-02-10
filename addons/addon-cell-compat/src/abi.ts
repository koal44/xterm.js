
/**
 * BIT LAYOUT (lsb -> msb):
 *
 *   [0]        appJoin    (1 bit)   compat: app join flag (xterm shouldJoin)
 *   [1..2]     appWidth   (2 bits)  compat: app width in columns (0..2; 3 reserved)
 *   [3..4]     movWidth   (2 bits)  compat: cursor traversal cost (0..2; 3 reserved)
 *   [5..6]     delWidth   (2 bits)  compat: deletion cost (0..2; 3 reserved)
 *   [7]        visJoin    (1 bit)   visual: uc-width shouldJoin (continuation/tail)
 *   [8..9]     visWidth   (2 bits)  visual: uc-width clusterWidth (0..2; 3 reserved)
 *   [10..24]   uc17State  (15 bits) visual: packed UC17 state machine (see packUc17State)
 *
 * Total used: 25 bits (0..24).
 */

import { UcWidthState } from 'vendor/uc-width/src';

// -----------------------------------------------
// Property ABI: shifts/masks + accessors
// -----------------------------------------------

export const APP_JOIN_SHIFT = 0;
export const APP_WIDTH_SHIFT = 1;
export const MOV_WIDTH_SHIFT = 3;
export const DEL_WIDTH_SHIFT = 5;
export const VIS_JOIN_SHIFT = 7;
export const VIS_WIDTH_SHIFT = 8;
export const UC17_SHIFT = 10;

const UC17_MASK = 0x7fff;

type UInt1 = 0 | 1;
type UInt2 = 0 | 1 | 2 | 3;
type UInt4 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

const cap2 = (x: number): 0|1|2 => (x <= 2 ? (x as 0 | 1 | 2) : 2);
export const getAppWidth  = (p: number): 0|1|2 => cap2((p >>> APP_WIDTH_SHIFT) & 0x3);
export const getVisWidth  = (p: number): 0|1|2 => cap2((p >>> VIS_WIDTH_SHIFT) & 0x3);
export const getUc17State = (p: number): number => (p >>> UC17_SHIFT) & UC17_MASK;
export const getAppJoin   = (p: number): boolean => ((p >>> APP_JOIN_SHIFT) & 0x1) !== 0;
export const getMovWidth  = (p: number): 0|1|2 => cap2((p >>> MOV_WIDTH_SHIFT) & 0x3);
export const getDelWidth  = (p: number): 0|1|2 => cap2((p >>> DEL_WIDTH_SHIFT) & 0x3);
export const getVisJoin   = (p: number): boolean => ((p >>> VIS_JOIN_SHIFT) & 0x1) !== 0;

interface ICompatProps {
  appJoin: boolean;
  appWidth: 0|1|2;
  movWidth: 0|1|2;
  delWidth: 0|1|2;
  visJoin: boolean;
  visWidth: 0|1|2;
  uc17State: number; // 15-bit
}

export function packProps(args: ICompatProps): number {
  let p = 0;
  p |= (args.appJoin ? 1 : 0) << APP_JOIN_SHIFT;
  p |= (args.appWidth & 3) << APP_WIDTH_SHIFT;
  p |= (args.movWidth & 3) << MOV_WIDTH_SHIFT;
  p |= (args.delWidth & 3) << DEL_WIDTH_SHIFT;
  p |= (args.visJoin ? 1 : 0) << VIS_JOIN_SHIFT;
  p |= (args.visWidth & 3) << VIS_WIDTH_SHIFT;
  p |= (args.uc17State & UC17_MASK) << UC17_SHIFT;
  return p >>> 0;
}

export const NULL_CELL_PROPS = packProps({
  appJoin: false,
  appWidth: 1,
  movWidth: 1,
  delWidth: 1,
  visJoin: false,
  visWidth: 1,
  uc17State: 0,
});

export const TAIL_CELL_PROPS = packProps({
  appJoin: false,
  appWidth: 0,
  movWidth: 0,
  delWidth: 0,
  visJoin: false,
  visWidth: 0,
  uc17State: 0,
});

// -----------------------------------------------
// UC17 (uc-width) 15-bit state pack/unpack
// -----------------------------------------------

// unpack helpers
const u1 = (x: number): boolean => (x & 0x1) !== 0;
const u2 = (x: number): UInt2 => (x & 0x3) as UInt2;
const u4 = (x: number): UInt4 => (x & 0xF) as UInt4;

// pack helpers
const p1 = (x: boolean): UInt1 => (x ? 1 : 0);
const p2 = (x: number): number => x & 0x3;
const p4 = (x: number): number => x & 0xF;

/**
 * UC17 packed state layout (15 bits, LSB -> MSB)
 *
 *   bit 0  : m.canNarrowVs15
 *   bit 1  : m.canWidenVs16
 *   bit 2  : g.started
 *   bit 3  : g.riOdd
 *   4..5   : g.epState
 *   6..7   : g.incbState       (2 bits, but only  3 states used)
 *   8..11  : g.lastProps.gcb   (4 bits, but only 14 states used)
 *   12..13 : g.lastProps.incb
 *   bit 14 : g.lastProps.ep
 */
export function packUc17State(state: UcWidthState): number {
  const { m, g } = state;

  let x = 0;
  x |= p1(m.canNarrowVs15) << 0;
  x |= p1(m.canWidenVs16) << 1;
  x |= p1(g.started) << 2;
  x |= p1(g.riOdd) << 3;
  x |= p2(g.epState) << 4;
  x |= p2(g.incbState) << 6;
  x |= p4(g.lastProps.gcb) << 8;
  x |= p2(g.lastProps.incb) << 12;
  x |= p1(g.lastProps.ep) << 14;

  return x;
}

export function unpackUc17State(packed15: number, prevVisWidth: 0|1|2): UcWidthState {
  const x = packed15 & UC17_MASK;

  const canNarrowVs15 = u1(x >>> 0);
  const canWidenVs16 = u1(x >>> 1);
  const started = u1(x >>> 2);
  const riOdd = u1(x >>> 3);
  const epState = u2(x >>> 4);
  const incbState = u2(x >>> 6);
  const gcb = u4(x >>> 8);
  const incb = u2(x >>> 12);
  const ep = u1(x >>> 14);

  if (!isGcb(gcb)) throw new Error(`Invalid gcb value in packed state: ${gcb}`);
  if (!isIncbState(incbState)) throw new Error(`Invalid incbState value in packed state: ${incbState}`);

  return {
    clusterWidth: prevVisWidth,
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
