type KeyAction = 'left' | 'right' | 'home' | 'end' | 'backspace' | 'delete';

const KEYMAP: Record<KeyAction, { key: string, code: string, keyCode: number }> = {
  left:      { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  right:     { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home:      { key: 'Home',       code: 'Home',       keyCode: 36 },
  end:       { key: 'End',        code: 'End',        keyCode: 35 },
  backspace: { key: 'Backspace',  code: 'Backspace',  keyCode: 8  },
  delete:    { key: 'Delete',     code: 'Delete',     keyCode: 46 },
};

export function fakeKeyDownEvent(
  action: KeyAction,
  mods: { ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean, shiftKey?: boolean },
): KeyboardEvent {
  const { key, code, keyCode } = KEYMAP[action];

  const ev = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
    repeat: false,
    ...mods,
  });

  const patch = (prop: 'keyCode' | 'which'): void => {
    try {
      Object.defineProperty(ev, prop, { get: () => keyCode });
    } catch { }
  };
  patch('keyCode');
  patch('which');

  return ev;
}

export function sendKey(term: any, action: KeyAction): void {
  const core = term?._core;
  if (!core) {
    console.warn('sendKey: terminal core not found');
    return;
  }
  core['_keyDown'](fakeKeyDownEvent(action, {}));
}
