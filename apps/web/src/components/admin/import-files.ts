/** Browser helpers for MIG-01: reading the chosen file and saving generated files. */

/** File → base64 without building one giant string from a spread (large files overflow the stack). */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function saveBase64(base64: string, fileName: string, type: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  saveBlob(new Blob([bytes], { type }), fileName);
}

/** `old register.xlsx` → `old register` (for naming the error report). */
export const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, '');
