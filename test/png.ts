import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** An 8-bit, non-interlaced PNG decoded to RGBA, so tests can check the real art instead of its filename. */
type Png = { readonly width: number; readonly height: number; readonly alpha: boolean; readonly rgba: Uint8Array };
type Rgba = readonly [number, number, number, number];

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function readPng(url: URL): Png {
  const file = readFileSync(url);
  if (file.subarray(1, 4).toString() !== "PNG") throw new Error(`${url.pathname} is not a PNG`);
  let offset = 8;
  let width = 0, height = 0, colorType = 0;
  const data: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString();
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error(`${url.pathname}: only 8-bit non-interlaced PNGs are supported`);
      colorType = body[9]!;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`${url.pathname}: unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      pixels[y * stride + x] = (row[x]! + unfilter(filter, left, up, corner)) & 0xff;
    }
  }
  // Index arithmetic only. A view and two arrays per pixel came to ~5M short-lived objects per companion sheet, and the
  // GC churn made sheet tests time out when the machine was busy (#142).
  const rgba = channels === 4 ? pixels : new Uint8Array(width * height * 4);
  const grey = channels < 3;
  if (channels !== 4) for (let p = 0, o = 0; o < rgba.length; p += channels, o += 4) {
    rgba[o] = pixels[p]!;
    rgba[o + 1] = pixels[grey ? p : p + 1]!;
    rgba[o + 2] = pixels[grey ? p : p + 2]!;
    rgba[o + 3] = channels === 2 ? pixels[p + 1]! : 255;
  }
  return { width, height, alpha: colorType === 4 || colorType === 6, rgba };
}

function unfilter(filter: number, left: number, up: number, corner: number): number {
  switch (filter) {
    case 0: return 0;
    case 1: return left;
    case 2: return up;
    case 3: return (left + up) >> 1;
    case 4: {
      const p = left + up - corner;
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      return pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
    }
    default: throw new Error(`unknown PNG filter ${filter}`);
  }
}

export function pixel(png: Png, x: number, y: number): Rgba {
  const i = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!, png.rgba[i + 3]!];
}

/** The median colour of a rectangle given in fractions of the image, robust to the odd highlight pixel. */
export function medianColor(png: Png, box: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }): Rgba {
  const channels: number[][] = [[], [], [], []];
  const x0 = Math.floor(box.left * png.width), x1 = Math.ceil(box.right * png.width);
  const y0 = Math.floor(box.top * png.height), y1 = Math.ceil(box.bottom * png.height);
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) pixel(png, x, y).forEach((v, c) => channels[c]!.push(v));
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!;
  return [median(channels[0]!), median(channels[1]!), median(channels[2]!), median(channels[3]!)];
}

/** WCAG 2 contrast ratio between two opaque colours. */
export function contrast(a: Rgba | string, b: Rgba | string): number {
  const lum = (c: Rgba | string) => {
    const [r, g, b] = typeof c === "string" ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c;
    const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
