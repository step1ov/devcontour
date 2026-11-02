import { crc32, inflateSync } from 'node:zlib';
import type { VisualImage } from '../core/visual.ts';

/**
 * Минимальный декодер PNG для снимков экрана: 8 бит на канал, RGB или RGBA,
 * без interlace. Снимки симулятора и браузера такие и есть; прочие варианты
 * получают понятный отказ вместо новой зависимости.
 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Пределы снимка: защищают от распаковки многогигабайтного буфера. */
export const PNG_MAX_SIDE = 8192;
export const PNG_MAX_PIXELS = 16 * 1024 * 1024;

export function decodePng(file: Buffer): VisualImage {
  if (file.length < 8 || !file.subarray(0, 8).equals(SIGNATURE)) throw new Error('файл не PNG');
  let offset = 8;
  let header: { width: number; height: number; channels: number } | undefined;
  const data: Buffer[] = [];
  let ended = false;
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + length + 4 > file.length) throw new Error('PNG обрезан');
    const chunk = file.subarray(start, start + length);
    if (crc32(file.subarray(offset + 4, start + length)) !== file.readUInt32BE(start + length))
      throw new Error(`CRC блока ${type} PNG не совпадает`);
    offset = start + length + 4;
    if (!header && type !== 'IHDR') throw new Error('PNG должен начинаться с IHDR');
    if (type === 'IHDR') {
      if (header) throw new Error('в PNG больше одного IHDR');
      if (length !== 13) throw new Error('IHDR PNG должен иметь длину 13');
      const width = chunk.readUInt32BE(0),
        height = chunk.readUInt32BE(4);
      const [depth, color, compression, filter, interlace] = chunk.subarray(8, 13);
      if (compression !== 0 || filter !== 0) throw new Error('неизвестный метод сжатия PNG');
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0)
        throw new Error('поддерживается PNG 8 бит RGB/RGBA без interlace');
      if (
        !width ||
        !height ||
        width > PNG_MAX_SIDE ||
        height > PNG_MAX_SIDE ||
        width * height > PNG_MAX_PIXELS
      )
        throw new Error(`размер PNG ${width}×${height} вне пределов`);
      header = { width, height, channels: color === 6 ? 4 : 3 };
    } else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!header) throw new Error('в PNG нет IHDR');
  if (!ended) throw new Error('PNG обрезан: нет IEND');
  if (!data.length) throw new Error('в PNG нет данных изображения');
  const { width, height, channels } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('размер данных PNG не совпадает');
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const corner = i >= channels ? previous[i - channels] : 0;
      let predictor: number;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left),
          pb = Math.abs(p - up),
          pc = Math.abs(p - corner);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else throw new Error(`неизвестный фильтр PNG ${filter}`);
      current[i] = (line[i] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4,
        from = x * channels;
      out[to] = current[from];
      out[to + 1] = current[from + 1];
      out[to + 2] = current[from + 2];
      out[to + 3] = channels === 4 ? current[from + 3] : 255;
    }
    previous = current;
  }
  return { width, height, data: out };
}
