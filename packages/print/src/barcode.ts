/**
 * Code 128 (subset B) as an inline SVG, for the visit number on the OPD sheet and the UHID on the
 * card. Subset B covers every printable ASCII character, which is all a visit number
 * (`OP/26-27/004512`) or UHID (`UH-000123`) uses. Pure and dependency free.
 */

/** Bar/space widths (bar first) of symbols 0–105, as digit strings; each sums to 11 modules. */
export const CODE128_PATTERNS = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
] as const;
const STOP = '2331112';
const START_B = 104;

/** Symbol values (start, data, check, stop excluded) for `text`; throws on non-printable input. */
export function code128BValues(text: string): number[] {
  const values = [START_B];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code > 126) throw new Error('code128: printable ASCII only');
    values.push(code - 32);
  }
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  values.push(check);
  return values;
}

/** Module widths alternating bar, space, bar … for the whole symbol including stop. */
export function code128BWidths(text: string): number[] {
  const digits = [...code128BValues(text).map((v) => CODE128_PATTERNS[v]), STOP].join('');
  return [...digits].map(Number);
}

/**
 * SVG that stretches to its container (`preserveAspectRatio="none"`): size it with CSS. A
 * 10-module quiet zone on both sides keeps scanners happy.
 */
export function code128Svg(text: string): string {
  const quiet = 10;
  const widths = code128BWidths(text);
  const total = widths.reduce((a, b) => a + b, 0) + 2 * quiet;
  let x = quiet;
  const bars: string[] = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="1"/>`);
    x += w;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 1" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${escapeAttr(text)}"><g fill="#000">${bars.join('')}</g></svg>`;
}

const escapeAttr = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
