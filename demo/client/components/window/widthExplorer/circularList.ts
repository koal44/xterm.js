export class CircularList {
  private _buf: string[] = [];
  private _head = 0;

  constructor(private readonly _max: number) {}

  public push(s: string): void {
    this._buf.push(s);

    const live = this._buf.length - this._head;
    const over = live - this._max;
    if (over > 0) this._head += over;

    // Compact occasionally
    if (this._head > 1024 && this._head * 2 > this._buf.length) {
      this._buf = this._buf.slice(this._head);
      this._head = 0;
    }
  }

  public clear(): void {
    this._buf.length = 0;
    this._head = 0;
  }

  public toString(): string {
    return this._buf.slice(this._head).join('');
  }
}
