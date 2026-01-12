/* eslint-disable max-len */
/* eslint-disable @stylistic/indent */
/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/consistent-type-definitions */

import * as Tables from './gen/grapheme-tables.js';
import { RangeTable } from './range.js';

const GCB = {
  Other: 0, // aka XX
  CR: 1,
  LF: 2,
  Control: 3,
  Extend: 4,
  ZWJ: 5,
  RegionalIndicator: 6,
  Prepend: 7,
  SpacingMark: 8,
  L: 9,
  V: 10,
  T: 11,
  LV: 12,
  LVT: 13,
} as const;

type GcbClass = typeof GCB[keyof typeof GCB];

const INCB = {
  None: 0,
  Consonant: 1,
  Extend: 2,
  Linker: 3,
} as const;

type IncbClass = typeof INCB[keyof typeof INCB];

type GraphemeProps = {
  gcb: GcbClass;
  incb: IncbClass;
  ep: boolean;
};

// for debugging
// export function fmtProps(p?: GraphemeProps): string {
//   if (!p) return '<none>';
//   const GCB_NAME = Object.fromEntries(Object.entries(GCB).map(([k, v]) => [v, k] as const)) as Record<number, string>;
//   const INCB_NAME = Object.fromEntries(Object.entries(INCB).map(([k, v]) => [v, k] as const)) as Record<number, string>;
//   return `gcb=${GCB_NAME[p.gcb]} incb=${INCB_NAME[p.incb]} ep=${p.ep}`;
// }

let _cr: RangeTable | null = null;
let _lf: RangeTable | null = null;
let _control: RangeTable | null = null;
let _extend: RangeTable | null = null;
let _zwj: RangeTable | null = null;
let _ri: RangeTable | null = null;
let _prepend: RangeTable | null = null;
let _spacingMark: RangeTable | null = null;

let _l: RangeTable | null = null;
let _v: RangeTable | null = null;
let _t: RangeTable | null = null;
let _lv: RangeTable | null = null;
let _lvt: RangeTable | null = null;

let _ep: RangeTable | null = null;
let _incbC: RangeTable | null = null;
let _incbE: RangeTable | null = null;
let _incbL: RangeTable | null = null;

export const T = {
  get cr(): RangeTable { return _cr ??= new RangeTable(Tables.CR); },
  get lf(): RangeTable { return _lf ??= new RangeTable(Tables.LF); },
  get control(): RangeTable { return _control ??= new RangeTable(Tables.CONTROL); },
  get extend(): RangeTable { return _extend ??= new RangeTable(Tables.EXTEND); },
  get zwj(): RangeTable { return _zwj ??= new RangeTable(Tables.ZWJ); },
  get ri(): RangeTable { return _ri ??= new RangeTable(Tables.REGIONAL_INDICATOR); },
  get prepend(): RangeTable { return _prepend ??= new RangeTable(Tables.PREPEND); },
  get spacingMark(): RangeTable { return _spacingMark ??= new RangeTable(Tables.SPACING_MARK); },

  get l(): RangeTable { return _l ??= new RangeTable(Tables.L); },
  get v(): RangeTable { return _v ??= new RangeTable(Tables.V); },
  get t(): RangeTable { return _t ??= new RangeTable(Tables.T); },
  get lv(): RangeTable { return _lv ??= new RangeTable(Tables.LV); },
  get lvt(): RangeTable { return _lvt ??= new RangeTable(Tables.LVT); },

  // extended pictographic
  get ep(): RangeTable { return _ep ??= new RangeTable(Tables.EXTENDED_PICTOGRAPHIC); },

  // Indic_Conjunct_Break values
  get incbC(): RangeTable { return _incbC ??= new RangeTable(Tables.INCB_CONSONANT); },
  get incbE(): RangeTable { return _incbE ??= new RangeTable(Tables.INCB_EXTEND); },
  get incbL(): RangeTable { return _incbL ??= new RangeTable(Tables.INCB_LINKER); },
} as const;

export function getGraphemeProps(codePoint: number): GraphemeProps {
  let gcb: GcbClass = GCB.Other;
  let incb: IncbClass = INCB.None;
  let ep = false;

  if (T.cr.has(codePoint)) gcb = GCB.CR;
  else if (T.lf.has(codePoint)) gcb = GCB.LF;
  else if (T.control.has(codePoint)) gcb = GCB.Control;
  else if (T.extend.has(codePoint)) gcb = GCB.Extend;
  else if (T.zwj.has(codePoint)) gcb = GCB.ZWJ;
  else if (T.ri.has(codePoint)) gcb = GCB.RegionalIndicator;
  else if (T.prepend.has(codePoint)) gcb = GCB.Prepend;
  else if (T.spacingMark.has(codePoint)) gcb = GCB.SpacingMark;
  else if (T.l.has(codePoint)) gcb = GCB.L;
  else if (T.v.has(codePoint)) gcb = GCB.V;
  else if (T.t.has(codePoint)) gcb = GCB.T;
  else if (T.lv.has(codePoint)) gcb = GCB.LV;
  else if (T.lvt.has(codePoint)) gcb = GCB.LVT;

  if (T.ep.has(codePoint)) ep = true;

  if (T.incbC.has(codePoint)) incb = INCB.Consonant;
  else if (T.incbE.has(codePoint)) incb = INCB.Extend;
  else if (T.incbL.has(codePoint)) incb = INCB.Linker;

  return { gcb, incb, ep };
}

type EpState =
  | 0 // not in an extended pictographic sequence
  | 1 // \p{Extended_Pictographic}
  | 2 // \p{Extended_Pictographic} Extend*
  | 3 // \p{Extended_Pictographic} Extend* ZWJ
  ;

type IncbState =
  | 0 // not tracking (pattern not active)
  | 1 // seen a Consonant in this cluster; no Linker yet
  | 2 // seen Consonant ... Linker ... (and still only Extend/Linker since)
  ;

export type GraphemeState = {
  started: boolean;
  lastProps: GraphemeProps;
  riOdd: boolean;
  epState: EpState;
  incbState: IncbState;
};

const INIT_GRAPHEME_STATE: GraphemeState = {
  started: false,
  lastProps: { gcb: GCB.Other, incb: INCB.None, ep: false },
  riOdd: false,
  epState: 0,
  incbState: 0,
};

export function initialGraphemeState(): GraphemeState {
  return { ...INIT_GRAPHEME_STATE, lastProps: { ...INIT_GRAPHEME_STATE.lastProps } };
}

export type GraphemeStepResult = {
  shouldJoin: boolean;
  state: GraphemeState;
};

export function graphemeStep(cp: number, state?: GraphemeState): GraphemeStepResult {
  if (!state) state = INIT_GRAPHEME_STATE;
  const isSot = !state.started;

  const curr = getGraphemeProps(cp);
  const prev = state.lastProps;

  let shouldJoin: boolean;

  // https://www.unicode.org/reports/tr29/#Grapheme_Cluster_Boundary_Rules
  if (isSot) {
    // GB1: sot ÷
    shouldJoin = false;
  } else if (prev.gcb === GCB.CR && curr.gcb === GCB.LF) {
    // GB3: CR × LF
    shouldJoin = true;
  } else if (prev.gcb === GCB.Control || prev.gcb === GCB.CR || prev.gcb === GCB.LF) {
    // GB4: (Control | CR | LF) ÷
    shouldJoin = false;
  } else if (curr.gcb === GCB.Control || curr.gcb === GCB.CR || curr.gcb === GCB.LF) {
    // GB5: ÷ (Control | CR | LF)
    shouldJoin = false;
  } else if (prev.gcb === GCB.L && (curr.gcb === GCB.L || curr.gcb === GCB.V || curr.gcb === GCB.LV || curr.gcb === GCB.LVT)) {
    // GB6: L × (L | V | LV | LVT)
    shouldJoin = true;
  } else if ((prev.gcb === GCB.LV || prev.gcb === GCB.V) && (curr.gcb === GCB.V || curr.gcb === GCB.T)) {
    // GB7: (LV | V) × (V | T)
    shouldJoin = true;
  } else if ((prev.gcb === GCB.LVT || prev.gcb === GCB.T) && curr.gcb === GCB.T) {
    // GB8: (LVT | T) × T
    shouldJoin = true;
  } else if (curr.gcb === GCB.Extend || curr.gcb === GCB.ZWJ) {
    // GB9: × (Extend | ZWJ)
    shouldJoin = true;
  } else if (curr.gcb === GCB.SpacingMark) {
    // GB9a: × SpacingMark
    shouldJoin = true;
  } else if (prev.gcb === GCB.Prepend) {
    // GB9b: Prepend ×
    shouldJoin = true;
  } else if (curr.incb === INCB.Consonant && state.incbState === 2) {
    // GB9c: p{InCB=Consonant} [ \p{InCB=Extend} \p{InCB=Linker} ]* \p{InCB=Linker} [ \p{InCB=Extend} \p{InCB=Linker} ]* × \p{InCB=Consonant}
    shouldJoin = true;
  } else if (state.epState === 3 && curr.ep) {
    // GB11: \p{Extended_Pictographic} Extend* ZWJ × \p{Extended_Pictographic}
    shouldJoin = true;
  } else if (curr.gcb === GCB.RegionalIndicator && state.riOdd) {
    // GB12: sot (RI RI)* RI × RI
    // GB13: [^RI] (RI RI)* RI × RI
    shouldJoin = true;
  } else {
    // GB999: Any ÷ Any
    shouldJoin = false;
  }

  const riOdd = curr.gcb === GCB.RegionalIndicator && !state.riOdd;
  const epState =
    curr.ep     ? 1 :
    !shouldJoin ? 0 :
    state.epState === 1 && curr.gcb === GCB.Extend ? 2 :
    state.epState === 1 && curr.gcb === GCB.ZWJ    ? 3 :
    state.epState === 2 && curr.gcb === GCB.Extend ? 2 :
    state.epState === 2 && curr.gcb === GCB.ZWJ    ? 3 :
    0;

  const incbState =
    curr.incb === INCB.Consonant ? 1 :
    !shouldJoin ? 0 :
    state.incbState === 1 && curr.incb === INCB.Extend ? 1 :
    state.incbState === 1 && curr.incb === INCB.Linker ? 2 :
    state.incbState === 2 && curr.incb === INCB.Extend ? 2 :
    state.incbState === 2 && curr.incb === INCB.Linker ? 2 :
    0;

  return { shouldJoin, state: { started: true, lastProps: curr, riOdd, epState, incbState } };
}
