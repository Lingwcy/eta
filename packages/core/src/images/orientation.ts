/** JPEG EXIF orientation is metadata, not part of the decoded pixel layout. */
export function jpegOrientation(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (view.getUint16(0) !== 0xffd8) return 1;
    for (let offset = 2; offset + 4 < bytes.length;) {
      const marker = view.getUint16(offset);
      if (marker === 0xffda || marker === 0xffd9) break;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
        const start = offset + 10;
        const little = view.getUint16(start) === 0x4949;
        const directory = start + view.getUint32(start + 4, little);
        const count = view.getUint16(directory, little);
        for (let index = 0; index < count; index++) {
          const entry = directory + 2 + index * 12;
          if (view.getUint16(entry, little) === 0x112) {
            const orientation = view.getUint16(entry + 8, little);
            return orientation >= 1 && orientation <= 8 ? orientation : 1;
          }
        }
      }
      offset += length + 2;
    }
  } catch {
    /* Missing or malformed metadata leaves the pixel layout unchanged. */
  }
  return 1;
}
