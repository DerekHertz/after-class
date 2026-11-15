/**
 * The size a JPEG declares in its header, read without decoding a pixel. A frame is accepted only if this agrees with the
 * width and height its fact declares, so a few magic bytes followed by anything else is not a frame.
 */
export function jpegSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2) return null;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) {
      if (i + 9 > bytes.length) return null;
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}
