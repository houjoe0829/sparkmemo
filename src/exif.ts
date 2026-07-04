/**
 * Minimal EXIF capture-time reader for JPEG images.
 *
 * Only extracts what's needed to answer "when was this photo taken" —
 * DateTimeOriginal (preferred), falling back to DateTimeDigitized, then the
 * plain DateTime tag — by walking the TIFF structure inside the JPEG's APP1
 * segment. Deliberately not a full EXIF parser; no external dependency.
 */

const TAG_DATE_TIME = 0x0132;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;
const TAG_EXIF_IFD_POINTER = 0x8769;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Offset (into `view`) of the inline value, or of the 4-byte value-offset field. */
  valueOffset: number;
}

function readIfd(view: DataView, ifdOffset: number, little: boolean): IfdEntry[] {
  const count = view.getUint16(ifdOffset, little);
  const entries: IfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = ifdOffset + 2 + i * 12;
    entries.push({
      tag: view.getUint16(base, little),
      type: view.getUint16(base + 2, little),
      count: view.getUint32(base + 4, little),
      valueOffset: base + 8,
    });
  }
  return entries;
}

/** Reads an ASCII (type 2) IFD entry's string value. */
function readAscii(
  view: DataView,
  entry: IfdEntry,
  tiffStart: number,
  little: boolean,
): string | null {
  if (entry.type !== 2) return null;
  const offset =
    entry.count <= 4 ? entry.valueOffset : tiffStart + view.getUint32(entry.valueOffset, little);
  if (offset < 0 || offset + entry.count > view.byteLength) return null;
  let str = '';
  for (let j = 0; j < entry.count; j++) {
    const code = view.getUint8(offset + j);
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  return str;
}

/** Reads a LONG (type 4) IFD entry's single value. */
function readLong(view: DataView, entry: IfdEntry, little: boolean): number | null {
  if (entry.type !== 4 || entry.count < 1) return null;
  return view.getUint32(entry.valueOffset, little);
}

/** Parses EXIF's "YYYY:MM:DD HH:MM:SS" ASCII datetime as a local `Date`. */
function parseExifDateTime(raw: string): Date | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readTiffCaptureDate(view: DataView, tiffStart: number): Date | null {
  const byteOrder = view.getUint16(tiffStart);
  const little = byteOrder === 0x4949; // "II"
  if (!little && byteOrder !== 0x4d4d /* "MM" */) return null;

  const ifd0Offset = tiffStart + view.getUint32(tiffStart + 4, little);
  const ifd0 = readIfd(view, ifd0Offset, little);

  const dateTimeEntry = ifd0.find(e => e.tag === TAG_DATE_TIME);
  const exifPointerEntry = ifd0.find(e => e.tag === TAG_EXIF_IFD_POINTER);

  let originalRaw: string | null = null;
  let digitizedRaw: string | null = null;
  if (exifPointerEntry) {
    const exifIfdOffset = readLong(view, exifPointerEntry, little);
    if (exifIfdOffset !== null) {
      const exifIfd = readIfd(view, tiffStart + exifIfdOffset, little);
      const originalEntry = exifIfd.find(e => e.tag === TAG_DATE_TIME_ORIGINAL);
      const digitizedEntry = exifIfd.find(e => e.tag === TAG_DATE_TIME_DIGITIZED);
      originalRaw = originalEntry ? readAscii(view, originalEntry, tiffStart, little) : null;
      digitizedRaw = digitizedEntry ? readAscii(view, digitizedEntry, tiffStart, little) : null;
    }
  }

  const raw =
    originalRaw ??
    digitizedRaw ??
    (dateTimeEntry ? readAscii(view, dateTimeEntry, tiffStart, little) : null);
  return raw ? parseExifDateTime(raw) : null;
}

/**
 * Reads the EXIF capture time from a JPEG's raw bytes.
 *
 * Returns `null` for non-JPEG images, JPEGs without an EXIF APP1 segment, or
 * any structure this couldn't confidently parse — callers should treat that
 * as "no EXIF timestamp available", not an error.
 */
export function readExifCaptureDate(buffer: ArrayBuffer): Date | null {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG (SOI marker)

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xda) break; // start-of-scan — no more metadata segments follow
      const segmentLength = view.getUint16(offset + 2);

      if (marker === 0xe1) {
        const segStart = offset + 4;
        const isExif =
          segStart + 6 <= view.byteLength &&
          view.getUint32(segStart) === 0x45786966 && // "Exif"
          view.getUint16(segStart + 4) === 0x0000;
        if (isExif) return readTiffCaptureDate(view, segStart + 6);
        return null;
      }

      offset += 2 + segmentLength;
    }
    return null;
  } catch {
    return null; // malformed/truncated segment — treat as "no EXIF"
  }
}
