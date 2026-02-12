import { AttributeData, ExtendedAttrs } from 'common/buffer/AttributeData';
import { IExtendedAttrs } from 'common/Types';

export class RenderCell extends AttributeData {
  public fg: number = 0;
  public bg: number = 0;
  public extended: IExtendedAttrs = new ExtendedAttrs();

  public width: number = 1;
  public visWidth: number = 1;

  // public codepoint: number = 0;
  public chars: string = '';
  public code: number = 0;

  public charJoined: boolean = false; // whether this cell was fused by characterJoiner service
  public visJoin: boolean = false; // whether this cell should visually join to the prev cell (e.g. grapheme cluster)
}
