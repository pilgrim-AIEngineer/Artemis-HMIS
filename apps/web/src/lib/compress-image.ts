'use client';

import { fitWithin, RX_SCAN_JPEG_QUALITY, RX_SCAN_MAX_SIDE } from '@hmis/shared';

/**
 * Client-side compression of a photo before upload (docs/01 §2): scaled to at most 1600 px on
 * its longest side and re-encoded as JPEG at quality 0.8, so a 12-megapixel phone photo becomes a
 * few hundred kB on the hospital Wi-Fi. EXIF orientation is applied by `createImageBitmap`.
 */
export async function compressImage(
  source: Blob | HTMLVideoElement,
  maxSide = RX_SCAN_MAX_SIDE,
  quality = RX_SCAN_JPEG_QUALITY,
): Promise<Blob> {
  const bitmap =
    source instanceof Blob
      ? await createImageBitmap(source, { imageOrientation: 'from-image' })
      : await createImageBitmap(source);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('jpeg encoding failed'))),
        'image/jpeg',
        quality,
      ),
    );
  } finally {
    bitmap.close();
  }
}

/** Base64 of a blob (for the tRPC upload), without the `data:` prefix. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
