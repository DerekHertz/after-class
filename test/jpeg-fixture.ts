/** A JPEG that is only a header: SOI, a 640x360 start-of-frame and EOI. Enough for the backend to read its size, too small to decode. */
export function headerJpeg(width = 640, height = 360, padBytes = 0): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00];
  const pad = padBytes > 0 ? [0xff, 0xfe, ((padBytes + 2) >> 8) & 0xff, (padBytes + 2) & 0xff, ...Array.from({ length: padBytes }, () => 0)] : [];
  return new Uint8Array([0xff, 0xd8, ...pad, ...sof, 0xff, 0xd9]);
}

export const JPEG_BYTES = headerJpeg();
