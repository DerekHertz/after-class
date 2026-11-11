import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { pixel, readPng } from "./png";

// A tiny PNG encoder for the decoder's own tests: one IDAT, each row with the filter it names.
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
function paeth(left: number, up: number, corner: number): number {
  const p = left + up - corner;
  const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
}
function encode(width: number, height: number, colorType: number, channels: number, samples: Uint8Array, filters: readonly number[]): Buffer {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]!;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? samples[y * stride + x - channels]! : 0;
      const up = y > 0 ? samples[(y - 1) * stride + x]! : 0;
      const corner = x >= channels && y > 0 ? samples[(y - 1) * stride + x - channels]! : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter]!;
      raw[y * (stride + 1) + 1 + x] = (samples[y * stride + x]! - predicted) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, colorType, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

const dir = mkdtempSync(join(tmpdir(), "after-class-png-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readPng decodes every 8-bit colour type through every row filter", () => {
  const width = 5, height = 10, filters = [0, 1, 2, 3, 4];
  const cases = [
    { name: "grey", colorType: 0, channels: 1, alpha: false, rgba: (s: number[]) => [s[0]!, s[0]!, s[0]!, 255] },
    { name: "rgb", colorType: 2, channels: 3, alpha: false, rgba: (s: number[]) => [s[0]!, s[1]!, s[2]!, 255] },
    { name: "grey + alpha", colorType: 4, channels: 2, alpha: true, rgba: (s: number[]) => [s[0]!, s[0]!, s[0]!, s[1]!] },
    { name: "rgba", colorType: 6, channels: 4, alpha: true, rgba: (s: number[]) => [s[0]!, s[1]!, s[2]!, s[3]!] },
  ];
  for (const { name, colorType, channels, alpha, rgba } of cases) {
    test(name, () => {
      // Deterministic, uneven samples so every predictor sees real neighbours and wraps past 255.
      const samples = Uint8Array.from({ length: width * height * channels }, (_, i) => (i * 37 + (i >> 3) * 101) & 0xff);
      const path = join(dir, `${colorType}.png`);
      writeFileSync(path, encode(width, height, colorType, channels, samples, filters));
      const png = readPng(pathToFileURL(path));
      expect({ width: png.width, height: png.height, alpha: png.alpha }).toEqual({ width, height, alpha });
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        expect(pixel(png, x, y)).toEqual(rgba([...samples.subarray(i, i + channels)]) as [number, number, number, number]);
      }
    });
  }
});
