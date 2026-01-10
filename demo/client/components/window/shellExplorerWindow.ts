/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * shell/line-editor explorer for measuring column space.
 */

import { BaseWindow } from './baseWindow';
import type { Terminal } from '@xterm/xterm';
import type { AddonCollection } from 'types';

const TEST_PREFIX = 'ABC';
const TESTS = [
  '🙂',
  '👨‍🌾',
  '👨‍👩‍👧‍👦',
  '🇺🇳',
];

const TYPICAL_KEYS = { left: '\x1b[D', right: '\x1b[C', del: '\x7f' } as const;

const SHELL_PROFILES = [
  {
    id: 'bash',
    label: 'bash (GNU Readline)',
    keys: {
      ...TYPICAL_KEYS,
      clear: '\x15',       // ^U unix-line-discard
      home: '\x1b[H',      // CSI H
      end: '\x1b[F',       // CSI F
    }
  },
  {
    id: 'zsh',
    label: 'zsh (Zsh Line Editor / ZLE)',
    keys: {
      ...TYPICAL_KEYS,
      clear: '\x15',       // commonly backward-clear-line / clear-whole-line
      home: '\x1bOH',
      end: '\x1bOF',
    }
  },
  {
    id: 'fish',
    label: 'fish (Command line editor)',
    keys: {
      ...TYPICAL_KEYS,
      clear: '\x15',
      home: '\x1bOH',
      end: '\x1bOF',
    }
  },
  {
    id: 'pwsh',
    label: 'pwsh (PSReadLine)',
    keys: {
      ...TYPICAL_KEYS,
      clear: '\x1b', // ESC, undo line edits
      home: '\x1b[H',
      end: '\x1b[F',
    }
  }
] as const satisfies readonly {
  id: string;
  label: string;
  keys: { clear: string; left: string; right: string; home: string; end: string; del: string };
}[];

type ShellProfile = typeof SHELL_PROFILES[number];
type ShellProfileId = ShellProfile['id'];

type SocketReporter = { log: string[]; /* on: boolean; */ };
const REPORTER = new WeakMap<WebSocket, SocketReporter>();
const UTF8 = new TextDecoder('utf-8', { fatal: false });

export class ShellExplorerWindow extends BaseWindow {
  public readonly id = 'shell-explorer';
  public readonly label = 'Shell';

  private _out!: HTMLPreElement;
  private _rep: SocketReporter | undefined;
  private _profile: ShellProfile = SHELL_PROFILES[0];
  private _showZwj = false;
  private _useTestPrefix = false;

  constructor(
    terminal: Terminal,
    addons: AddonCollection,
    private readonly _deps: { getSocket: () => WebSocket | undefined },
  ) {
    super(terminal, addons);
  }

  public build(container: HTMLElement): void {
    const root = document.createElement('div');
    container.appendChild(root);

    // Shell profile
    addRow(root, 'profile: ',
      mkSelect(SHELL_PROFILES, this._profile.id, id => this._setProfile(id), 'Shell profile (key sequences)'),
    );

    // Line editor ops
    addRow(root, 'line: ',
      mkButton('CLEAR', 'Clear the current line', () => {
        this._inject(this._profile.keys.clear);
      }),
    );

    // Cursor / movement
    addRow(root, 'cursor: ',
      mkButton('←', 'Left (profile-specific)', () => this._inject(this._profile.keys.left)),
      mkButton('→', 'Right (profile-specific)', () => this._inject(this._profile.keys.right)),
      mkButton('HOME', 'Home (profile-specific)', () => this._inject(this._profile.keys.home)),
      mkButton('END', 'End (profile-specific)', () => this._inject(this._profile.keys.end)),
    );

    // Delete
    const delN = mkNumericUpDown('DEL repeat count', 1, 64, 1, 1);
    addRow(root, 'delete: ',
      delN,
      mkButton('DEL', 'Send DEL × N', () => {
        const n = Math.max(1, Math.min(64, +delN.value));
        this._inject(this._profile.keys.del.repeat(n));
      }),
    );

    // Test cases
    addRow(root, 'test cases: ',
      ...TESTS.map(t => mkButton(t, `Inject ${t}`, () => this._inject((this._useTestPrefix ? TEST_PREFIX : '') + t)))
    );

    // Options
    addRow(root, 'opts: ',
      mkCheckbox('show zwj', 'render ZWJ as {zwj} in trace?', this._showZwj, v => { this._showZwj = v; }),
      mkCheckbox('test prefix', `prefix test inputs with ${TEST_PREFIX}`, this._useTestPrefix, v => { this._useTestPrefix = v; }),
    );

    // Output
    const pre = document.createElement('pre');
    pre.textContent = `[dev] shell profile = ${this._profile.id}\n`;
    this._out = pre;
    root.appendChild(pre);

    // first, early attempt at installing the reporter (socket creation is async)
    // alternatively, use mutation observer on visibility
    setTimeout(() => this._tryInstallReporter(), 500);
  }

  // State / actions
  private _setProfile(id: ShellProfileId): void {
    this._profile = SHELL_PROFILES.find(p => p.id === id)!;
    this._appendOut(`[dev] shell profile = ${this._profile.id}\n`);
  }

  private _drainLog(): void {
    const lines = this._rep?.log.splice(0);
    if (lines?.length) this._appendOut(lines.join('\n') + '\n');
  }

  private _tryInstallReporter(): void {
    if (this._rep) return;
    const s = this._deps.getSocket();
    if (s) this._rep = this.installSocketReporter(s);
  }

  private _inject(data: string): void {
    this._tryInstallReporter();

    const coreService = (this._terminal as any)?._core?.coreService;
    const trigger = coreService?.triggerDataEvent as ((d: string, w: boolean) => void) | undefined;
    if (!trigger) return this._appendOut('[dev] term not ready for triggerDataEvent\n');
    trigger.call(coreService, data, true);
  }

  private _appendOut(s: string): void {
    this._out.textContent += s;
  }

  private installSocketReporter(socket: WebSocket): SocketReporter {
    const cached = REPORTER.get(socket);
    if (cached) return cached;

    try { socket.binaryType = 'arraybuffer'; } catch {}

    const rep: SocketReporter = {
      log: [],
    };

    const origSend = socket.send.bind(socket);
    socket.send = ((data: any) => {
      this.logSock(rep, '<<< ', data);
      return origSend(data);
    }) as any;

    socket.addEventListener('message', (ev: MessageEvent) => {
      this.logSock(rep, '>>> ', ev.data);
    });

    REPORTER.set(socket, rep);
    return rep;
  }

  private logSock(rep: SocketReporter, prefix: '<<< ' | '>>> ', data: unknown): void {
    let s: string;
    if (typeof data === 'string') {
      s = escapeForLog(data, { zwj: this._showZwj });
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      s = this.previewBinary(data);
    } else if (data instanceof Blob) {
      s = `<<blob:${data.size}B:${data.type || 'unknown'}>>`;
    } else {
      s = `<<unknown:${Object.prototype.toString.call(data)}>>`;
    }

    rep.log.push(prefix + s);
    this._drainLog();
  }

  private previewBinary(data: ArrayBufferLike | ArrayBufferView): string {
    const u8 = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)

    return escapeForLog(UTF8.decode(u8), { zwj: this._showZwj });
  }
}

function escapeForLog(s: string, opts: { zwj?: boolean } = {}): string {
  // Make control characters visible, plus ZWJ marker.
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x1b) out += '\\x1b';
    else if (cp === 0x0d) out += '\\r';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x09) out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp === 0x200D && opts.zwj) out += '{zwj}';
    else out += ch;
  }
  return out;
}

// --- HTML factories ---

function mkCheckbox(label: string, title: string, checked: boolean, onChange: (v: boolean) => void) {
  const l = document.createElement('label');
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = checked;
  i.title = title;
  i.onchange = () => onChange(i.checked);
  l.append(i, label);
  return l;
}

function mkNumericUpDown(title: string, min: number, max: number, step: number, value: number, onChange?: (v: number) => void) {
  const i = document.createElement('input');
  i.type = 'number';
  i.title = title;
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  if (onChange) i.oninput = () => onChange(+i.value);
  return i;
}

function mkButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function mkSelect<T extends string>(
  items: readonly { id: T; label: string }[],
  selected: T,
  onChange: (id: T) => void,
  title: string,
) {
  const sel = document.createElement('select');
  sel.title = title;
  for (const { id, label } of items) sel.add(new Option(label, id, id === selected, id === selected));
  sel.onchange = () => onChange(sel.value as T);
  return sel;
}

function addRow(root: HTMLElement, label: string, ...nodes: (Node | string)[]) {
  root.append(label, ...nodes, document.createElement('br'));
}
