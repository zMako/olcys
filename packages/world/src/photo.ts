import { PNG } from 'pngjs';
import QRCode from 'qrcode';

const W = 480;
const H = 360;

/**
 * Draws the photo of an item for sale: a grey backdrop, a dark device with two fans and,
 * if a payload is given, a white sticker with a QR code — the way sellers put a wallet address on a picture.
 */
export function adPhoto(seed: number, payload?: string): Buffer {
  const png = new PNG({ width: W, height: H });
  let state = (seed * 2654435761) >>> 0;
  const noise = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 24) / 255 - 0.5;
  };
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  };
  const rect = (x0: number, y0: number, w: number, h: number, c: [number, number, number]) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, ...c);
  };
  const disc = (cx: number, cy: number, r: number, c: [number, number, number]) => {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, ...c);
  };

  // backdrop with a little sensor noise, darker table at the bottom
  const tint = seed % 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const base = y > 270 ? 96 : 196 - Math.round((y / 270) * 34);
      const n = Math.round(noise() * 10);
      set(x, y, base + n + (tint === 0 ? 6 : 0), base + n + (tint === 1 ? 6 : 0), base + n + (tint === 2 ? 8 : 0));
    }
  }
  // the device
  rect(46, 112, 226, 176, [44, 48, 54]);
  rect(54, 120, 210, 160, [58, 63, 70]);
  for (const cx of [108, 208]) {
    disc(cx, 200, 44, [30, 33, 38]);
    disc(cx, 200, 36, [78, 84, 92]);
    disc(cx, 200, 9, [30, 33, 38]);
  }
  disc(250, 132, 4, [40, 200, 90]);

  if (payload) {
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const scale = Math.max(3, Math.floor(132 / size));
    const side = size * scale;
    const pad = 12;
    const x0 = W - side - pad - 22;
    const y0 = H - side - pad - 28;
    rect(x0 - pad, y0 - pad, side + 2 * pad, side + 2 * pad, [250, 250, 248]);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (qr.modules.get(r, c)) rect(x0 + c * scale, y0 + r * scale, scale, scale, [12, 12, 14]);
      }
    }
  }
  return PNG.sync.write(png);
}
