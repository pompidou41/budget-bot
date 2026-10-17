import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import resvg from '@resvg/resvg-js';

const { renderAsync } = resvg;

// The same relative path works from src/render (tsx) and dist/render (node dist/index.js)
const FONT_FILES = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf'].map((name) =>
  fileURLToPath(new URL(`../../assets/fonts/${name}`, import.meta.url)),
);

/** Fixed zoom: the SVG is laid out in ~900 units, a phone wants more than that many pixels. */
const ZOOM = 2;

let fontsChecked = false;

function checkFonts(): void {
  if (fontsChecked) return;
  // Without them resvg would draw every label as nothing and still return a valid PNG
  const missing = FONT_FILES.filter((file) => !existsSync(file));
  if (missing.length > 0) throw new Error(`Fonts for rendering are missing: ${missing.join(', ')}`);
  fontsChecked = true;
}

/** Draws an SVG to PNG off the event loop. System fonts are off so the picture is the same everywhere. */
export async function svgToPng(svg: string): Promise<Buffer> {
  checkFonts();
  const image = await renderAsync(svg, {
    font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'zoom', value: ZOOM },
  });
  return image.asPng();
}
