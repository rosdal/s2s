import { PNG } from "pngjs";

/** Small binary writers and readers for the placeholder and clone assets. No native code. */

function wavHeader(dataBytes: number, rate: number, bits: 8 | 16): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * bits) / 8, 28);
  h.writeUInt16LE(bits / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Mono 8-bit PCM WAV of silence, `durationMs` long. */
export function silentWav(durationMs: number, rate = 8_000): Buffer {
  const samples = Math.max(1, Math.round((durationMs / 1000) * rate));
  return Buffer.concat([wavHeader(samples, rate, 8), Buffer.alloc(samples, 128)]);
}

/** Mono 8-bit PCM WAV from samples in [-1, 1]. At 12 kHz that is 96 kbps. */
export function pcm8Wav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data[i] = Math.round(v * 127 + 128);
  }
  return Buffer.concat([wavHeader(data.length, rate, 8), data]);
}

/** A flat grey PNG (4×4 by default): what proxy textures become. */
export function placeholderPng(width = 4, height = 4, grey = 128): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(grey);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return PNG.sync.write(png);
}

/** Width and height from a PNG, JPEG, WebP, GIF or KTX2 header, without decoding pixels. */
export function imageSize(
  bytes: Uint8Array,
): { width: number; height: number; format: string } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: "png" };
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF")
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: "gif" };
  if (
    b.length >= 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8 ")
      return {
        width: b.readUInt16LE(26) & 0x3fff,
        height: b.readUInt16LE(28) & 0x3fff,
        format: "webp",
      };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
    }
    if (kind === "VP8X")
      return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, format: "webp" };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] as number;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), format: "jpeg" };
      i += 2 + len;
    }
    return null;
  }
  if (isKtx2(b)) return { width: b.readUInt32LE(20), height: b.readUInt32LE(24), format: "ktx2" };
  return null;
}

const KTX2_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
export const isKtx2 = (b: Uint8Array) => b.length >= 80 && KTX2_ID.every((v, i) => b[i] === v);

/**
 * An uncompressed KTX2 texture (VK_FORMAT_R8G8B8A8_SRGB, one level), which three's KTX2Loader
 * reads without its Basis transcoder.
 */
export function ktx2Rgba(width: number, height: number, rgba: Uint8Array, srgb = true): Buffer {
  const dfdBlock = 24 + 16 * 4;
  const dfdLength = 4 + dfdBlock;
  const headerLength = 80;
  const levelIndex = 24;
  const dfdOffset = headerLength + levelIndex;
  const dataOffset = Math.ceil((dfdOffset + dfdLength) / 16) * 16;
  const out = Buffer.alloc(dataOffset + rgba.length);
  KTX2_ID.forEach((v, i) => {
    out[i] = v;
  });
  out.writeUInt32LE(srgb ? 43 : 37, 12); // vkFormat
  out.writeUInt32LE(1, 16); // typeSize
  out.writeUInt32LE(width, 20);
  out.writeUInt32LE(height, 24);
  out.writeUInt32LE(0, 28); // depth
  out.writeUInt32LE(0, 32); // layers
  out.writeUInt32LE(1, 36); // faces
  out.writeUInt32LE(1, 40); // levels
  out.writeUInt32LE(0, 44); // supercompression
  out.writeUInt32LE(dfdOffset, 48);
  out.writeUInt32LE(dfdLength, 52);
  out.writeUInt32LE(0, 56); // kvd offset
  out.writeUInt32LE(0, 60); // kvd length
  out.writeBigUInt64LE(0n, 64); // sgd offset
  out.writeBigUInt64LE(0n, 72); // sgd length
  out.writeBigUInt64LE(BigInt(dataOffset), 80);
  out.writeBigUInt64LE(BigInt(rgba.length), 88);
  out.writeBigUInt64LE(BigInt(rgba.length), 96);
  let o = dfdOffset;
  out.writeUInt32LE(dfdLength, o);
  o += 4;
  out.writeUInt32LE(0, o); // vendor 0, descriptor type 0
  out.writeUInt16LE(2, o + 4); // version
  out.writeUInt16LE(dfdBlock, o + 6);
  out[o + 8] = 1; // color model RGBSDA
  out[o + 9] = 1; // BT.709 primaries
  out[o + 10] = srgb ? 2 : 1; // transfer
  out[o + 11] = 0; // flags
  // texel block dimensions 0,0,0,0; bytesPlane0 = 4
  out[o + 16] = 4;
  const channels = [0, 1, 2, 15];
  for (let i = 0; i < 4; i++) {
    const s = o + 24 + i * 16;
    out.writeUInt16LE(i * 8, s);
    out[s + 2] = 7;
    out[s + 3] = (channels[i] as number) | (i === 3 && srgb ? 0x10 : 0); // alpha is linear (KHR_DF_SAMPLE_DATATYPE_LINEAR)
    out.writeUInt32LE(0, s + 8);
    out.writeUInt32LE(255, s + 12);
  }
  out.set(rgba, dataOffset);
  return out;
}

/** A neutral sky-to-ground gradient as RGB floats, `width` × `height`. */
export function gradientPixels(width: number, height: number): Float32Array {
  const px = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1);
    const v = 0.9 - 0.6 * t;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v * 1.05;
    }
  }
  return px;
}

function toRgbe(r: number, g: number, b: number): [number, number, number, number] {
  const v = Math.max(r, g, b);
  if (v < 1e-32) return [0, 0, 0, 0];
  const e = Math.ceil(Math.log2(v) + 1e-9);
  const scale = 256 / 2 ** e;
  return [
    Math.min(255, r * scale),
    Math.min(255, g * scale),
    Math.min(255, b * scale),
    e + 128,
  ].map(Math.floor) as [number, number, number, number];
}

/** A flat (not run-length encoded) Radiance `.hdr`, which three's RGBELoader reads. */
export function encodeHdr(width: number, height: number, rgb: Float32Array): Buffer {
  const header = Buffer.from(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
    "ascii",
  );
  const body = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, e] = toRgbe(rgb[i * 3] ?? 0, rgb[i * 3 + 1] ?? 0, rgb[i * 3 + 2] ?? 0);
    body[i * 4] = r;
    body[i * 4 + 1] = g;
    body[i * 4 + 2] = b;
    body[i * 4 + 3] = e;
  }
  return Buffer.concat([header, body]);
}

/** Decode a Radiance `.hdr` (flat or run-length encoded) to RGB floats. */
export function decodeHdr(
  bytes: Uint8Array,
): { width: number; height: number; rgb: Float32Array } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!b.toString("ascii", 0, 2).startsWith("#?")) return null;
  let pos = 0;
  let width = 0;
  let height = 0;
  while (pos < b.length) {
    const end = b.indexOf(0x0a, pos);
    if (end < 0) return null;
    const line = b.toString("ascii", pos, end);
    pos = end + 1;
    const m = /^-Y (\d+) \+X (\d+)$/.exec(line.trim());
    if (m) {
      height = Number(m[1]);
      width = Number(m[2]);
      break;
    }
  }
  if (!width || !height) return null;
  const rgbe = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rgbe.subarray(y * width * 4, (y + 1) * width * 4);
    if (
      width >= 8 &&
      width < 0x8000 &&
      b[pos] === 2 &&
      b[pos + 1] === 2 &&
      !((b[pos + 2] as number) & 0x80)
    ) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width && pos < b.length) {
          let count = b[pos++] as number;
          if (count > 128) {
            count -= 128;
            const v = b[pos++] as number;
            for (let k = 0; k < count && x < width; k++) row[x++ * 4 + c] = v;
          } else for (let k = 0; k < count && x < width; k++) row[x++ * 4 + c] = b[pos++] as number;
        }
      }
    } else {
      row.set(b.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
  }
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3] as number;
    const f = e === 0 ? 0 : 2 ** (e - 136);
    rgb[i * 3] = (rgbe[i * 4] as number) * f;
    rgb[i * 3 + 1] = (rgbe[i * 4 + 1] as number) * f;
    rgb[i * 3 + 2] = (rgbe[i * 4 + 2] as number) * f;
  }
  return { width, height, rgb };
}

/** Box-filter RGB floats down so the width is at most `maxWidth`. */
export function downscaleRgb(
  width: number,
  height: number,
  rgb: Float32Array,
  maxWidth: number,
): { width: number; height: number; rgb: Float32Array } {
  const f = Math.max(1, Math.ceil(width / maxWidth));
  if (f === 1) return { width, height, rgb };
  const w = Math.max(1, Math.floor(width / f));
  const h = Math.max(1, Math.floor(height / f));
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < f; dy++)
          for (let dx = 0; dx < f; dx++)
            sum += rgb[((y * f + dy) * width + x * f + dx) * 3 + c] ?? 0;
        out[(y * w + x) * 3 + c] = sum / (f * f);
      }
  return { width: w, height: h, rgb: out };
}

function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const i = new Uint32Array(f.buffer)[0] as number;
  const sign = (i >>> 16) & 0x8000;
  let exp = ((i >>> 23) & 0xff) - 127 + 15;
  const mant = i & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  exp = exp << 10;
  return sign | exp | (mant >>> 13);
}

/** An uncompressed scanline OpenEXR (half RGBA), which three's EXRLoader reads. */
export function encodeExr(width: number, height: number, rgb: Float32Array): Buffer {
  const attrs: Buffer[] = [];
  const attr = (name: string, type: string, value: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeInt32LE(value.length);
    attrs.push(Buffer.from(`${name}\0${type}\0`, "ascii"), size, value);
  };
  const channels = ["A", "B", "G", "R"];
  attr(
    "channels",
    "chlist",
    Buffer.concat([
      ...channels.map((c) => {
        const b = Buffer.alloc(c.length + 1 + 16);
        b.write(`${c}\0`, 0, "ascii");
        b.writeInt32LE(1, c.length + 1); // HALF
        b.writeInt32LE(1, c.length + 1 + 8); // xSampling
        b.writeInt32LE(1, c.length + 1 + 12); // ySampling
        return b;
      }),
      Buffer.from([0]),
    ]),
  );
  attr("compression", "compression", Buffer.from([0]));
  const box = Buffer.alloc(16);
  box.writeInt32LE(0, 0);
  box.writeInt32LE(0, 4);
  box.writeInt32LE(width - 1, 8);
  box.writeInt32LE(height - 1, 12);
  attr("dataWindow", "box2i", box);
  attr("displayWindow", "box2i", box);
  attr("lineOrder", "lineOrder", Buffer.from([0]));
  const one = Buffer.alloc(4);
  one.writeFloatLE(1);
  attr("pixelAspectRatio", "float", one);
  attr("screenWindowCenter", "v2f", Buffer.alloc(8));
  attr("screenWindowWidth", "float", one);
  const magic = Buffer.alloc(8);
  magic.writeUInt32LE(20000630, 0);
  magic.writeUInt32LE(2, 4);
  const header = Buffer.concat([magic, ...attrs, Buffer.from([0])]);
  const lineBytes = width * 2 * 4;
  const tableStart = header.length;
  const firstLine = tableStart + height * 8;
  const table = Buffer.alloc(height * 8);
  const lines: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    table.writeBigUInt64LE(BigInt(firstLine + y * (8 + lineBytes)), y * 8);
    const line = Buffer.alloc(8 + lineBytes);
    line.writeInt32LE(y, 0);
    line.writeInt32LE(lineBytes, 4);
    for (const [ci, c] of channels.entries())
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        const v = c === "A" ? 1 : (rgb[i + (c === "R" ? 0 : c === "G" ? 1 : 2)] ?? 0);
        line.writeUInt16LE(toHalf(v), 8 + ci * width * 2 + x * 2);
      }
    lines.push(line);
  }
  return Buffer.concat([header, table, ...lines]);
}
