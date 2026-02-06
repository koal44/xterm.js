/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/consistent-type-definitions */
/* eslint-disable max-len */

import * as UC from './gen/wc-tables.js';
import { graphemeStep, initialGraphemeState, type GraphemeState } from './grapheme.js';
import { RangeTable, subtractRanges } from './range.js';

/** Options controlling how specific code points are measured (cell width 0–2). Defaults via {@link ucWidthOptions}. */
export type UcWidthOptions = {
  /** NUL (U+0000): 0 => width 0 (default); 1 => width 1. */
  nul: 0 | 1;

  /** Controls (GC=Cc, excluding NUL): 0 => width 0 (default); 1 => width 1. */
  control: 0 | 1;

  /** EAW Ambiguous (A): 1 => narrow (default); 2 => wide. */
  ambiguous: 1 | 2;

  /** VS15 (U+FE0E): 1 => allow eligible emoji bases to narrow to 1 (default); 2 => ignore VS15 narrowing. */
  vs15: 1 | 2;
};

/** Opaque state for {@link ucWidthStep}. Compact (≈17 bits). Use the returned state as the input state for the next call. */
export type UcWidthState = {
  clusterWidth: 0 | 1 | 2;    // current cluster width
  g: GraphemeState;
  m: MeasureState;
};

/** Result of {@link ucWidthStep} for a single code point. */
export type UcWidthStepResult = {
  /** Whether the code point continues the previous grapheme cluster. */
  shouldJoin: boolean;

  /** Width (0–2) of the current cluster after consuming the code point. */
  clusterWidth: 0 | 1 | 2;

  /** Opaque state to pass to the next call to {@link ucWidthStep}. */
  state: UcWidthState;
};

const UC_WIDTH_DEFAULTS: UcWidthOptions = { nul: 0, control: 0, ambiguous: 1, vs15: 1 };

/** Returns {@link UcWidthOptions} by merging defaults with `overrides`. */
export function ucWidthOptions(overrides: Partial<UcWidthOptions> = {}): UcWidthOptions {
  return { ...UC_WIDTH_DEFAULTS, ...overrides };
}

type MeasureState = {
  canNarrowVs15: boolean;
  canWidenVs16: boolean;
};

const INIT_MEASURE_STATE: MeasureState = {
  canNarrowVs15: false,
  canWidenVs16: false,
};

type MeasureStepResult = {
  deltaWidth: number;
  state: MeasureState;
};

let _controlTable: RangeTable | null = null;
let _zeroWidthTable: RangeTable | null = null;
let _wideTable: RangeTable | null = null;
let _ambiguousTable: RangeTable | null = null;
let _vs16CanWidenTable: RangeTable | null = null;
let _vs16CanWidenNoAmbTable: RangeTable | null = null;
let _emojiVs15Table: RangeTable | null = null;

const TABLES = {
  get control(): RangeTable { return _controlTable ??= new RangeTable(UC.CONTROL_RANGES); },
  get zeroWidth(): RangeTable { return _zeroWidthTable ??= new RangeTable([...UC.ZERO_WIDTH_RANGES]); },
  get wide(): RangeTable { return _wideTable ??= new RangeTable([...UC.EAW_WIDE_RANGES]); },
  get ambiguous(): RangeTable { return _ambiguousTable ??= new RangeTable(UC.EAW_AMBIGUOUS_RANGES); },
  get vs16CanWiden(): RangeTable { return _vs16CanWidenTable ??= new RangeTable(UC.VS16_CAN_WIDEN_RANGES); },
  get vs16CanWidenNoAmb(): RangeTable {
    return _vs16CanWidenNoAmbTable ??= new RangeTable(
      subtractRanges(UC.VS16_CAN_WIDEN_RANGES, UC.EAW_AMBIGUOUS_RANGES),
    );
  },
  get emojiVs15Wide(): RangeTable { return _emojiVs15Table ??= new RangeTable(UC.VS15_CAN_NARROW_RANGES); },
};

/**
 * Returns the total terminal cell width of `str`, accounting for grapheme clusters.
 * For incremental measurement, use {@link ucWidthStep}.
 */
export function ucWidth(str: string, opts: Partial<UcWidthOptions> = {}): number {
  const fullOpts = ucWidthOptions(opts);

  let total = 0;
  let state: UcWidthState = initialUcWidthState();

  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    const prevClusterWidth = state.clusterWidth;
    const step = ucWidthStep(cp, fullOpts, state);

    if (!step.shouldJoin) total += prevClusterWidth;

    state = step.state;
  }

  total += state.clusterWidth;
  return total;
}

/**
 * For streaming text, returns whether `cp` joins the current grapheme cluster and the cluster width (0–2) after consuming it.
 * Omit `state` at start-of-text (SOT) and feed `result.state` into the next call.
 */
export function ucWidthStep(cp: number, opts: UcWidthOptions, state?: UcWidthState): UcWidthStepResult {
  state ??= initialUcWidthState();

  // fast path for printable ASCII
  if (cp >= 0x20 && cp <= 0x7E) {
    const canWidenVs16 = cp === 0x23 || cp === 0x2A || (cp >= 0x30 && cp <= 0x39); // '#', '*', '0'..'9' (keycap bases)
    return {
      shouldJoin: false,
      clusterWidth: 1,
      state: {
        clusterWidth: 1,
        g: { ...initialGraphemeState(), started: true },
        m: { canNarrowVs15: false, canWidenVs16 },
      },
    };
  }

  let { clusterWidth } = state;
  const gResult = graphemeStep(cp, state.g);
  const mResult = measureStep(cp, opts, state.m);

  if (!gResult.shouldJoin) {
    clusterWidth = 0;
  }

  const x = clusterWidth + mResult.deltaWidth;
  clusterWidth = x <= 0 ? 0 : x >= 2 ? 2 : 1; // clamp to 0..2

  return {
    shouldJoin: gResult.shouldJoin,
    clusterWidth,
    state: { clusterWidth, g: gResult.state, m: mResult.state },
  };
}

// not needed to run the stepper, but could be useful for bit packing
export function initialUcWidthState(): UcWidthState {
  return {
    clusterWidth: 0,
    g: initialGraphemeState(),
    m: { ...INIT_MEASURE_STATE },
  };
}

function measureStep(cp: number, opts: UcWidthOptions, state?: MeasureState): MeasureStepResult {
  let { canNarrowVs15, canWidenVs16 } = state ?? INIT_MEASURE_STATE;
  let deltaWidth = 1;

  if (TABLES.control.has(cp)) {
    deltaWidth = cp === 0 ? opts.nul : opts.control;
  } else if (opts.vs15 === 1 && canNarrowVs15 && cp === 0xFE0E) {
    deltaWidth = -1; // narrowing
  } else if (canWidenVs16 && cp === 0xFE0F) {
    deltaWidth = 1; // widening
  } else if (TABLES.zeroWidth.has(cp)) {
    deltaWidth = 0;
  } else if (TABLES.wide.has(cp) || (opts.ambiguous === 2 && TABLES.ambiguous.has(cp))) {
    deltaWidth = 2;
  }

  canNarrowVs15 = TABLES.emojiVs15Wide.has(cp);
  canWidenVs16 = opts.ambiguous === 1 ?
    TABLES.vs16CanWiden.has(cp) : TABLES.vs16CanWidenNoAmb.has(cp);

  return { deltaWidth, state: { canNarrowVs15, canWidenVs16 } };
}
