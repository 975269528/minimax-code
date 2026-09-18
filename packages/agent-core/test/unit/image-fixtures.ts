// Synthetic format headers for parser tests; no user images or captured requests.
function jpeg(width: number, height: number, exif = false): string {
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  const prefix = exif ? Buffer.from([0xff, 0xe1, 0, 8, 69, 120, 105, 102, 0, 0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), prefix, frame, Buffer.from([0xff, 0xd9])]).toString('base64');
}
const png = Buffer.alloc(33);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.writeUInt32BE(13, 8);
png.write('IHDR', 12);
png.writeUInt32BE(40, 16);
png.writeUInt32BE(24, 20);
export const NORMAL_40X24_PNG = png.toString('base64');
export const NORMAL_64X48_JPEG = jpeg(64, 48);
export const THIN_432X2_JPEG = jpeg(432, 2);
export const BOUNDARY_100X7_JPEG = jpeg(100, 7);
export const BOUNDARY_100X8_JPEG = jpeg(100, 8);
export const EXIF_80X60_JPEG = jpeg(80, 60, true);
export const CORRUPT_TRUNCATED_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8]).toString('base64');
export const MALFORMED_SHORT_SOF_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 3, 8, 0, 5, 0, 7, 3]).toString('base64');
export const UNSUPPORTED_50X50_WEBP = Buffer.from('RIFF0000WEBPVP8 synthetic').toString('base64');
