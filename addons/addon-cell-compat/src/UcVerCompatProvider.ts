import { type IUnicodeVersionProvider } from '@xterm/xterm';
import { UnicodeService } from 'common/services/UnicodeService';

export class UcVerCompatProvider implements IUnicodeVersionProvider {
  public readonly version = 'compat';

  public wcwidth(cp: number): 0 | 1 | 2 {
    return 0;
  }

  public charProperties(cp: number, preceding: number): number {
    const width = 0;
    const shouldJoin = false;
    return UnicodeService.createPropertyValue(0, width, shouldJoin);
  }
}
