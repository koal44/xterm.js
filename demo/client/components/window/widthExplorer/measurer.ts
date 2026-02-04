import { MeasuredWidths } from 'components/window/widthExplorer/measuredTable';
import { decodeData, hexToStr } from 'components/window/widthExplorer/stringUtil';
import type { IAppProfile, IMsgReaderTimeoutPolicy } from 'components/window/widthExplorerWindow';

const RE_CUB = /\x1b\[(\d*)D/;                  // CUB: cursor back n
const RE_CUF = /\x1b\[(\d*)C/;                  // CUF: cursor forward n
const RE_TAIL_CR_CUF = /\r(?:\x1b\[(\d*)C)+$/;  // tail CR + CUF only
const RE_CUP = /\x1b\[(\d+);(\d+)H/;            // CUP: cursor position r;c
const RE_BS_ONLY = /^\x08+$/;                   // BS: only backspaces
const RE_TRAILING_BS = /\x08+$/;                // backspaces at end of msg
const RE_CUV = /\x1b\[(\d*)[AB]/;               // any vertical movement (CUU/CUD)

interface IMeasureState {
  promptWidth?: number;
  homeOffset?: number;   // expect 0 when HOME ack succeeds
  endOffset?: number;    // measured after END
  content?: string;
}

interface IMeasureOpt { col?: boolean, mov?: boolean, del?: boolean }
type MeasureFn = (payload: string) => Promise<number>;

type MessageAwaiter = (until: (m: string) => boolean, timeoutMs: number, reportTimeout?: boolean) => Promise<string | undefined>;

export class Measurer {
  private _msgReader: MessageReader;
  private _readUntil: MessageAwaiter;
  private _state: IMeasureState = {};
  private _runAttempts = 5;
  private _runCount = 0;

  constructor(
    private _socket: WebSocket,
    private _profile: IAppProfile,
    private _timeoutPolicy: IMsgReaderTimeoutPolicy,
    private _prefix: string,
    private _suffix: string,
  ) {
    this._msgReader = new MessageReader(this._socket, this._timeoutPolicy);
    this._readUntil = this._msgReader.readUntil;

    for (const ch of this._prefix + this._suffix) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || cp > 0xff || (cp >= 0x7f && cp <= 0x9f)) {
        throw new Error(`Measurer: marker chars must be in [0x20..0xFF] excluding [0x7F..0x9F]; got ${hexToStr(cp)}`);
      }
    }
  }

  public async run(payload: string, measure: IMeasureOpt, logPerf: boolean): Promise<MeasuredWidths> {
    if (logPerf) this._runPerfLogger();
    await this._runUpkeep();

    const m: MeasuredWidths = {};
    if (measure.col) m.col = await this._retry(this._runAttempts, () => this._measureColWidth(payload));
    if (measure.mov) m.mov = await this._retry(this._runAttempts, () => this._measureMovWidth(payload));
    if (measure.del) m.del = await this._retry(this._runAttempts, () => this._measureDelWidth(payload));

    this._runCount++;
    return m;
  }

  private _lastReject?: { attempt: number, value: number };
  private async _retry(maxAttempts: number, fn: () => Promise<number>): Promise<number> {
    this._lastReject = undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fn();
      if (Number.isFinite(res) && res >= 0) return res;
      this._lastReject = { attempt, value: res };
      this._invalidateState();
    }
    return NaN;
  }

  public async dispose(): Promise<void> {
    try {
      await this._clearLine();
    } catch { } finally {
      this._msgReader.dispose();
    }
  }

  private async _runUpkeep(): Promise<void> {
    const upkeep = this._profile.upkeep;
    if (!upkeep) return;
    if ((this._runCount % upkeep.everyRuns) !== 0) return;
    await this._clearLine(); // ensure upkeepCmd is performed on clean line
    this._socket.send(upkeep.cmd);
    this._invalidateState(); // don't trust upkeep to preserve state
    await this._readUntil(() => true, upkeep.timeoutMs, false); // assume some ack
    await this._clearScreen(); // ensure clean slate after upkeep
    await this._readUntil(() => true, 30, false); // wait for some clearscreen ack
  }

  private _runPerfLogger(): void {
    const REC_EVERY = 1000;
    const self = this as any; // stash state on instance without touching class fields
    if (!self.__rec) self.__rec = { t0: performance.now(), lastT: performance.now(), lastN: 0 };
    const rec = self.__rec;
    const n = this._runCount;

    if (n > 0 && (n % REC_EVERY) === 0) {
      const now = performance.now();
      const dt = (now - rec.lastT) / 1000;
      const dN = n - rec.lastN;
      const total = (now - rec.t0) / 1000;
      const rps = dN / dt;
      const msPer = (now - rec.lastT) / dN;
      console.log(`[meas] n=${n}  +${dN} in ${dt.toFixed(1)}s  rps=${rps.toFixed(1)}  ms/run=${msPer.toFixed(2)}  t=${total.toFixed(1)}s`);
      rec.lastT = now;
      rec.lastN = n;
    }
  }

  private static _isHomeAck(msg: string): boolean {
    const isCursorMove = RE_CUB.test(msg) || RE_TRAILING_BS.test(msg) || RE_CUP.test(msg) || RE_TAIL_CR_CUF.test(msg) || RE_CUV.test(msg);
    if (!isCursorMove) return false;
    // if (msg.includes(TEST_PREFIX) || msg.includes(TEST_SUFFIX)) return false;
    // if (/[^\x00-\x7f]/.test(msg)) return false;
    return true;
  }

  private static _isEndAck(msg: string): boolean {
    const isCursorMove = RE_CUF.test(msg) || RE_CUP.test(msg) || RE_TAIL_CR_CUF.test(msg);
    if (!isCursorMove) return false;
    // if (msg.includes(TEST_PREFIX) || msg.includes(TEST_SUFFIX)) return false;
    // if (/[^\x00-\x7f]/.test(msg)) return false;
    return true;
  }

  private static _isLeftAck(msg: string): boolean {
    return Measurer._isHomeAck(msg);
  }

  private static _isDeleteAck(msg: string): boolean {
    return (
      msg.includes('\x08') ||            // BS anywhere (covers BS+EL, BS+spaces+BS, etc.)
      RE_CUB.test(msg) ||
      RE_CUF.test(msg) ||
      RE_CUP.test(msg) ||
      RE_TAIL_CR_CUF.test(msg) ||
      /\x1b\[K/.test(msg) ||            // EL (erase to line end)
      /\x1b\[\d*P/.test(msg)            // DCH (delete char) variants
    );
  }

  private static _isClearScreenAck(m: string): boolean {
    return (
      /\x1b\[\d*J/.test(m) ||
      /\x1b\[\d*H/.test(m) ||
      /\r/.test(m)
    );
  }

  private _invalidateState(): void {
    this._state.content = undefined;
    this._state.homeOffset = undefined;
    this._state.endOffset = undefined;
    // this._state.promptWidth = undefined; // keep promptWidth if known
  }

  private async _clearLine(): Promise<void> {
    if (this._state.content === '') return;

    if (this._profile.clearLineNeedsEnd && this._state.endOffset !== 0) {
      this._socket.send(this._profile.keys.end);
      await this._readUntil(() => true, 20, false);
    }

    this._socket.send(this._profile.keys.clearLine);
    await this._readUntil(() => true, 300, false);

    this._state.content = '';
    this._state.homeOffset = 0;
    this._state.endOffset = 0;
  }

  private async _clearScreen(): Promise<{ ok: boolean }> {
    this._socket.send(this._profile.keys.clearScreen);
    if (this._state.content) {
      const ack = await this._readUntil(m => m.includes(this._suffix), 1500);
      if (!ack) { this._invalidateState(); return { ok: false }; }
    } else {
      const ack = await this._readUntil(Measurer._isClearScreenAck, 1500);
      if (!ack) { this._invalidateState(); return { ok: false };}
    }
    return { ok: true };
  }

  private async _input(payload: string, prefix: string, suffix: string): Promise<{ok: boolean}> {
    const content = prefix + payload + suffix;
    if (this._state.content === content) return { ok: true };
    if (this._state.content !== '') await this._clearLine();

    this._socket.send(content);
    const ack = await this._readUntil(m => m.includes(suffix), 1000);
    if (!ack) {
      this._invalidateState(); return { ok: false };
    }

    this._state.endOffset = 0;
    this._state.homeOffset = undefined;
    this._state.content = content;
    return { ok: true };
  }

  private async _home(): Promise<{ ok: boolean }> {
    if (this._state.homeOffset === 0) return { ok: true };

    // Send HOME
    this._socket.send(this._profile.keys.home);
    const ack = await this._readUntil(Measurer._isHomeAck, 1100);
    if (!ack || RE_CUV.test(ack)) { // CUU on HOME when ramping means wrapping occurred
      this._invalidateState(); return { ok: false };
    }

    // HOME defines homeOffset
    const prevHomeOffset = this._state.homeOffset;
    this._state.homeOffset = 0;

    // learn promptWidth if we can
    const cup = ack.match(RE_CUP);
    if (cup) {
      const col = Number.parseInt(cup[2], 10);
      this._state.promptWidth = Number.isFinite(col) ? col - 1 : undefined;
    } else if (RE_TAIL_CR_CUF.test(ack)) {
      const n = parseWidthFromCUFMsg(ack);
      this._state.promptWidth = Number.isFinite(n) ? n : undefined;
    }

    // If we are not anchored to end, we can't update endOffset in this coordinate scheme.
    if (this._state.endOffset === undefined) {
      return { ok: true };
    }

    // How far did we move left from the previous position to reach HOME?
    const deltaLeft =
      RE_CUB.test(ack) ? parseWidthFromCUBMsg(ack)
        : RE_BS_ONLY.test(ack) ? parseWidthFromBSMsg(ack)
          : prevHomeOffset !== undefined ? prevHomeOffset
            : NaN;

    if (!Number.isFinite(deltaLeft)) {
      // can happen if HOME ack is absolute and we don't have previous info
      this._state.endOffset = undefined;
      return { ok: true };
    }

    this._state.endOffset += deltaLeft;
    return { ok: true };
  }

  private async _end(): Promise<{ ok: boolean }> {
    if (this._state.endOffset === 0) return { ok: true };

    // Send END
    this._socket.send(this._profile.keys.end);
    const ack = await this._readUntil(Measurer._isEndAck, 1200);
    if (!ack) return { ok: false };

    // END defines endOffset
    const prevEndOffset = this._state.endOffset;
    this._state.endOffset = 0;

    // How far did we move right from the previous position to reach END?
    let deltaRight: number = NaN;
    if (this._state.homeOffset === undefined) { // can't update without homeOffset
      return { ok: true };
    }

    // ABSOLUTE position
    let absCol: number | undefined;
    const cup = ack.match(RE_CUP);
    if (cup) {
      absCol = Number.parseInt(cup[2], 10);
    } else if (RE_TAIL_CR_CUF.test(ack)) {
      absCol = parseWidthFromCUFMsg(ack) + 1;
    }

    // Compute deltaRight from absolute or relative movement
    if (absCol !== undefined) {
      if (this._state.promptWidth === undefined) { // need promptWidth to compute homeOffset
        this._invalidateState(); return { ok: false };
      }
      const newHomeOffset = (absCol - 1) - this._state.promptWidth;
      deltaRight = newHomeOffset - this._state.homeOffset;
    } else if (RE_CUF.test(ack)) {
      deltaRight = parseWidthFromCUFMsg(ack);
    } else if (prevEndOffset !== undefined) {
      deltaRight = prevEndOffset;
    }

    // Update homeOffset from deltaRight
    if (!Number.isFinite(deltaRight)) { this._invalidateState(); return { ok: false }; }
    this._state.homeOffset += deltaRight;
    return { ok: true };
  }

  private async _left(): Promise<{ ok: boolean }> {
    this._socket.send(this._profile.keys.left);
    const ack = await this._readUntil(Measurer._isLeftAck, 900);
    if (!ack) return { ok: false };

    // If neither coordinate is known, we can't update anything.
    if (this._state.homeOffset === undefined && this._state.endOffset === undefined) {
      return { ok: false };
    }

    let deltaLeft: number = NaN;

    // ABSOLUTE position
    let absCol: number | undefined;
    const cup = ack.match(RE_CUP);
    if (cup) {
      absCol = Number.parseInt(cup[2], 10);
    } else if (RE_TAIL_CR_CUF.test(ack)) {
      absCol = parseWidthFromCUFMsg(ack) + 1;
    }

    // Compute deltaRight from absolute or relative movement
    if (absCol !== undefined) {
      if (this._state.promptWidth === undefined) { // need promptWidth to compute homeOffset
        this._invalidateState(); return { ok: false };
      }
      const newHomeOffset = (absCol - 1) - this._state.promptWidth;
      deltaLeft = this._state.homeOffset - newHomeOffset;
    } else {
      deltaLeft =
        RE_CUF.test(ack) ? -parseWidthFromCUFMsg(ack)
          : RE_CUB.test(ack) ? +parseWidthFromCUBMsg(ack)
            : RE_BS_ONLY.test(ack) ? +parseWidthFromBSMsg(ack)
              : NaN;
    }

    if (!Number.isFinite(deltaLeft) || deltaLeft < 0) { // something went wrong
      this._invalidateState(); return { ok: false };
    }

    // Update coordinates
    if (this._state.homeOffset !== undefined) this._state.homeOffset -= deltaLeft;
    if (this._state.endOffset !== undefined) this._state.endOffset += deltaLeft;
    return { ok: true };
  }

  private async _delete(): Promise<{ ok: boolean }> {
    this._socket.send(this._profile.keys.del);
    const ack = await this._readUntil(Measurer._isDeleteAck, 900);
    if (!ack) {
      this._invalidateState(); return { ok: false };
    }

    this._invalidateState();
    return { ok: true };
  }

  private async _ensureHomeOffset(): Promise<{ ok: boolean }> {
    if (this._state.homeOffset !== undefined) return { ok: true };
    return await this._home();
  }

  private async _ensureEndOffset(): Promise<{ ok: boolean }> {
    if (this._state.endOffset !== undefined) return { ok: true };
    return await this._end();
  }

  private _measureColWidth: MeasureFn = async (payload: string): Promise<number> => {
    let res = await this._input(payload, this._prefix, this._suffix);
    if (!res.ok) return NaN;

    res = await this._ensureHomeOffset(); if (!res.ok) return NaN;
    res = await this._ensureEndOffset(); if (!res.ok) return NaN;

    if (this._state.homeOffset !== undefined && this._state.endOffset !== undefined) {
      return this._state.homeOffset + this._state.endOffset - (this._prefix.length + this._suffix.length);
    }

    return NaN;
  };

  private _measureMovWidth: MeasureFn = async (payload: string): Promise<number> => {
    let res = await this._input(payload, this._prefix, this._suffix);
    if (!res.ok) return NaN;

    res = await this._ensureHomeOffset(); if (!res.ok) return NaN;
    res = await this._end(); if (!res.ok) return NaN;

    // We need total width as homeOffset so we can walk it down to 0 via LEFT presses.
    if (this._state.homeOffset === undefined) return NaN;

    let leftCount = 0;
    const MAX_LEFT = 10 * this._state.content!.length; // large enough for even zsh 8 hex + 2 <>
    while (this._state.homeOffset !== 0 && leftCount < MAX_LEFT) {
      // console.log(`measureState before LEFT #${leftCount + 1}:`, state);

      res = await this._left(); if (!res.ok) return NaN;

      if (this._state.homeOffset === undefined) return NaN; // lost coord
      if (this._state.homeOffset < 0) return NaN; // overshot

      leftCount++;
    }

    if (this._state.homeOffset !== 0) return NaN;

    // Subtract the ASCII scaffolding.
    return leftCount - (this._prefix.length + this._suffix.length);
  };

  private _measureDelWidth: MeasureFn = async (payload: string): Promise<number> => {
    const prefixNorm = this._prefix.length === 1 ? this._prefix + this._prefix : this._prefix;

    let res = await this._input(payload, prefixNorm, this._suffix);
    if (!res.ok) return NaN;

    res = await this._ensureHomeOffset(); if (!res.ok) return NaN;
    res = await this._end(); if (!res.ok) return NaN;

    if (this._state.homeOffset === undefined) return NaN;

    let nDel = 0;
    const MAX_DEL = 10 * this._state.content!.length; // large enough for even zsh 8 hex + 2 <>
    while (nDel < MAX_DEL) {
      // console.log(`measureState before DEL #${nDel + 1}:`, state);
      res = await this._delete(); if (!res.ok) return NaN;
      nDel++;

      // re-anchor HOME then END
      res = await this._home(); if (!res.ok) return NaN;
      res = await this._end(); if (!res.ok) return NaN;

      if (this._state.homeOffset === undefined) return NaN; // lost coord somehow
      if (this._state.homeOffset === prefixNorm.length - 1) {
        return nDel - ((prefixNorm.length - 1) + this._suffix.length);
      }
      if (this._state.homeOffset < 0) {
        return NaN; // overshot somehow
      }
    }

    return NaN;
  };
}

class MessageReader {
  private _pending?: { until: (msg: string) => boolean, resolve: (msg: string | undefined) => void, timer: number };

  constructor(private readonly _socket: WebSocket, private _policy: IMsgReaderTimeoutPolicy) {
    _socket.addEventListener('message', this._msgHandler);
  }

  private _msgHandler = (ev: MessageEvent): void => {
    const msg = decodeData(ev.data);
    if (this._pending?.until(msg)) {
      const w = this._pending;
      this._pending = undefined;
      window.clearTimeout(w.timer);
      w.resolve(msg);
    }
  };

  public readUntil: MessageAwaiter = (until, timeoutMs, reportTimeout = true) => {
    if (this._pending) {
      throw new Error('MessageReader.readUntl called while another waiter is pending');
    }

    return new Promise<string | undefined>((resolve) => {
      const timer = window.setTimeout(() => {
        this._pending = undefined;
        if (reportTimeout) {
          const msg = `timeout waiting for socket message (${timeoutMs}ms)`;
          if (this._policy.shouldThrowOnTimeout()) throw new Error(msg);
          console.error(msg);
        }
        resolve(undefined);
      }, timeoutMs);

      this._pending = { until, resolve, timer };
    });
  };

  public dispose(): void {
    this._socket.removeEventListener('message', this._msgHandler);

    if (this._pending) {
      this._pending.resolve(undefined);
      window.clearTimeout(this._pending.timer);
      this._pending = undefined;
    }
  }
}

function parseWidthFromCUFMsg(msg?: string, mode: 'sum' | 'last' = 'sum'): number {
  if (!msg) return NaN;

  // match CUF sequences; CR resets the accumulator
  const re = /\r|\x1b\[(\d*)C/g;

  let matched = false;
  let sum = 0;
  let last = NaN;

  for (let m; (m = re.exec(msg)) !== null;) {
    matched = true;

    // If this match is '\r', reset the segment accumulator.
    if (m[0] === '\r') {
      sum = 0;
      matched = false;
      last = NaN;
      continue;
    }

    // Empty means implicit 1 (bash/readline emits ESC[C repeatedly).
    const s = m[1];
    const n = s === '' ? 1 : Number(s);
    if (!Number.isFinite(n)) return NaN;

    sum += n;
    last = n;
  }

  if (!matched) return NaN;
  return mode === 'last' ? last : sum;
}

function parseWidthFromCUBMsg(msg?: string, mode: 'sum' | 'last' = 'sum'): number {
  if (!msg) return NaN;

  const re = /\x1b\[(\d*)D/g;

  let matched = false;
  let sum = 0;
  let last = NaN;

  for (let m; (m = re.exec(msg)) !== null;) {
    matched = true;

    // Empty means implicit 1.
    // should we treat 0 as 1 too?
    const s = m[1];
    const n = s === '' ? 1 : Number(s);
    if (!Number.isFinite(n)) return NaN;

    sum += n;
    last = n;
  }

  if (!matched) return NaN;
  return mode === 'last' ? last : sum;
}

// Count trailing BS (0x08) to get width.
// Note: intentionally ignores any earlier redraw noise; only the *suffix* matters.
function parseWidthFromBSMsg(msg?: string): number {
  if (!msg) return NaN;

  let n = 0;
  for (let i = msg.length - 1; i >= 0; i--) {
    if (msg.charCodeAt(i) === 0x08) n++;
    else break;
  }

  return n > 0 ? n : NaN;
}