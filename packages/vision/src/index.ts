import jpeg from 'jpeg-js';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

export interface ImageReading {
  kind: 'qr';
  /** What the code says, e.g. "bitcoin:bc1q…?amount=0.1". */
  text: string;
}

const MAX_PIXELS = 12_000_000;

function decodePixels(bytes: Uint8Array, contentType: string): { data: Uint8ClampedArray; width: number; height: number } | undefined {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  try {
    if (isPng || (!isJpeg && /png/i.test(contentType))) {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
    }
    if (isJpeg || /jpe?g/i.test(contentType)) {
      const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
      return { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height };
    }
  } catch {
    // not a readable image
  }
  return undefined;
}

/**
 * Reads what a picture says in machine-readable form. Today that is QR codes — the usual way
 * a wallet address is put on a photo of an item for sale. Runs locally; the image never leaves the machine.
 */
export function readImage(bytes: Uint8Array, contentType = ''): ImageReading[] {
  const px = decodePixels(bytes, contentType);
  if (!px || px.width * px.height > MAX_PIXELS) return [];
  const code = jsQR(px.data, px.width, px.height);
  return code?.data ? [{ kind: 'qr', text: code.data }] : [];
}
