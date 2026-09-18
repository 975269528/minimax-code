declare module 'bmp-js' {
  export interface BmpImage {
    width: number;
    height: number;
    bitPP?: number;
    data: Buffer;
  }

  export function decode(input: Buffer): BmpImage;
}
