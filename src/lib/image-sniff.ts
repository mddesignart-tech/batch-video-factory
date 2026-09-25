/**
 * Identify an image by its header rather than its name.
 *
 * These files are served back to the browser by the media route, which picks a
 * content type from the extension. Trusting the uploaded name alone would let
 * that route hand back the wrong type for arbitrary bytes.
 */
export function sniffImageType(bytes: Buffer): ".png" | ".jpg" | ".webp" | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return ".png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return null;
}
