import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** Unicode ranges of the two subsets needed for Polish text. */
const RANGES = {
  latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  'latin-ext': 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
};

let cached: string | undefined;

/**
 * @font-face rules with the font files embedded, so the report is one self-contained file
 * that looks the same on screen, in print and offline. Falls back to system fonts if the files are missing.
 */
export function embeddedFonts(): string {
  if (cached !== undefined) return cached;
  const faces: string[] = [];
  const add = (pkg: string, slug: string, family: string, weight: number, style: 'normal' | 'italic') => {
    const dir = join(dirname(require.resolve(`${pkg}/package.json`)), 'files');
    for (const subset of ['latin', 'latin-ext'] as const) {
      const data = readFileSync(join(dir, `${slug}-${subset}-${weight}-${style}.woff2`)).toString('base64');
      faces.push(`@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${RANGES[subset]};}`);
    }
  };
  try {
    for (const [weight, style] of [[400, 'normal'], [400, 'italic'], [600, 'normal'], [700, 'normal']] as const) add('@fontsource/brygada-1918', 'brygada-1918', 'Brygada 1918', weight, style);
    for (const weight of [400, 500]) add('@fontsource/ibm-plex-mono', 'ibm-plex-mono', 'IBM Plex Mono', weight, 'normal');
    cached = faces.join('\n');
  } catch {
    cached = '';
  }
  return cached;
}
