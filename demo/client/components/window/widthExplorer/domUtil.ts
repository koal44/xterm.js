export function mkCheckbox(label: string, title: string, checked: boolean, onChange: (v: boolean) => void): { label: HTMLLabelElement, input: HTMLInputElement } {
  const l = document.createElement('label');
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = checked;
  i.title = title;
  i.onchange = () => onChange(i.checked);
  l.append(i, label);
  return { label: l, input: i };
}

export function mkNumericUpDown(title: string, min: number, max: number, step: number, value: number, onChange?: (v: number) => void): HTMLInputElement {
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

export function mkButton(text: string, title: string, onClick: () => void, style?: Partial<CSSStyleDeclaration> | string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  b.style.boxSizing = 'border-box';
  b.style.height = '22px';
  b.style.padding = '0 4px';
  b.style.lineHeight = '1';
  if (style) {
    if (typeof style === 'string') {
      b.style.cssText += (b.style.cssText ? ';' : '') + style;
    } else {
      Object.assign(b.style, style);
    }
  }
  return b;
}

export function mkSelect<T extends string>(
  items: ReadonlyArray<{ id: T, label: string }>,
  selected: T | null,
  onChange: (id: T) => void,
  title: string,
  placeholder = '-- select --',
): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.title = title;
  sel.add(new Option(placeholder, '', selected === null, selected === null));
  sel.options[0].disabled = true;
  for (const { id, label } of items) sel.add(new Option(label, id, id === selected, id === selected));
  sel.value = selected ?? '';
  sel.onchange = () => onChange(sel.value as T);
  return sel;
}

export function mkLabeledInput(label: string, title: string, size: string, value: string, onChange?: (v: string) => void, style?: Partial<CSSStyleDeclaration> | string): { label: HTMLLabelElement, input: HTMLInputElement } {
  const l = document.createElement('label');
  const i = document.createElement('input');
  i.title = title;
  i.style.width = size;
  i.value = value;
  if (onChange) i.onchange = () => onChange(i.value);
  l.append(label, i);
  if (style) {
    if (typeof style === 'string') {
      l.style.cssText += (l.style.cssText ? ';' : '') + style;
    } else {
      Object.assign(l.style, style);
    }
  }
  return { label: l, input: i };
}

export function mkRadioCycle(
  items: string[],
  selected: string,
  title: string,
  onChange: (value: string) => void,
): { label: HTMLLabelElement, input: HTMLInputElement } {
  const label = document.createElement('label');
  label.title = title;
  const input = document.createElement('input');
  input.type = 'radio';
  input.checked = true;
  const text = document.createTextNode('');
  let idx = items.indexOf(selected);
  if (idx < 0) idx = 0;
  const render = (): void => { text.nodeValue = `${items[idx]} `; };
  label.addEventListener('click', (e) => {
    e.preventDefault();
    idx = (idx + 1) % items.length;
    render();
    onChange(items[idx]);
  });
  label.append(input, text);
  render();
  return { label, input };
}

export function addRow(root: HTMLElement, label: string, ...nodes: (Node | string)[]): void {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  if (label) row.append(label);
  for (const n of nodes) row.append(typeof n === 'string' ? document.createTextNode(n) : n);
  root.append(row);
}