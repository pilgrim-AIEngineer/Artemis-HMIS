import QRCode from 'qrcode';

/** Inline SVG of a QR code for `text` (document id), without XML prolog. */
export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
}

/** `Asha Singh` → `AS`; first letters of up to two words. */
export function initials(fullName: string): string {
  const letters = fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase());
  return letters.join('') || '?';
}
