// Test-only helpers for tokens.test.ts. Pure functions, no imports, never loaded by the app.

export type Rule = { selector: string; body: string; context: string[] };

/** Strip CSS comments. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Flatten a stylesheet into rules; at-rule blocks are recursed into and recorded as context. */
export function parseRules(css: string): Rule[] {
  const src = stripComments(css);
  const out: Rule[] = [];
  const walk = (text: string, context: string[]): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith("@")) {
        if (/^@(supports|media|layer|container)/.test(prelude)) walk(body, [...context, prelude]);
        else if (/^@keyframes/.test(prelude)) out.push({ selector: prelude, body, context });
        else out.push({ selector: prelude, body, context });
      } else {
        out.push({ selector: prelude.replace(/\s+/g, " "), body, context });
      }
      i = j;
    }
  };
  walk(src, []);
  return out;
}

export function isOklchContext(r: Rule): boolean {
  return r.context.some((c) => /^@supports/.test(c) && /oklch/.test(c));
}

/** Custom property declarations inside a rule body. */
export function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(?:^|[;\s])(--[\w-]+)\s*:\s*([^;]+?)\s*(?=;|$)/g)) out[m[1]] = m[2];
  return out;
}

export type Tokens = { base: Record<string, string>; oklch: Record<string, string> };

/** Custom properties declared on :root: base (hex fallback) and the @supports oklch override. */
export function parseTokens(css: string): Tokens {
  const base: Record<string, string> = {};
  const oklch: Record<string, string> = {};
  for (const r of parseRules(css)) {
    if (r.selector !== ":root") continue;
    Object.assign(isOklchContext(r) ? oklch : base, declarations(r.body));
  }
  return { base, oklch };
}

// ---- colour maths -------------------------------------------------------------------------

export type RGB = [number, number, number]; // 0..255

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(rgb: RGB): string {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** OKLCH (l 0..1, c chroma, h degrees) to a gamut-clamped sRGB hex string. */
export function oklchToHex(l: number, c: number, h: number): string {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const rl = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const gl = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const bl = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;
  const enc = (v: number): number => {
    const x = Math.max(0, Math.min(1, v));
    return (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255;
  };
  return rgbToHex([enc(rl), enc(gl), enc(bl)]);
}

/** Parse `oklch(0.72 0.14 250)` / `oklch(72% 0.14 250deg)` into a hex string. */
export function parseOklch(value: string): string {
  const m = value.trim().match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)$/);
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  const l = m[1].endsWith("%") ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
  const c = m[2].endsWith("%") ? (parseFloat(m[2]) / 100) * 0.4 : parseFloat(m[2]);
  return oklchToHex(l, c, parseFloat(m[3]));
}

/**
 * The Activity Map ramp (ui/activity/model.ts colour()): `color-mix(in srgb, heat P%, zero)` with
 * P = 18 + 82 * sqrt(t), t = heat / max. t <= 0 is the zero fill.
 */
export function sampleRamp(zero: string, heat: string, t: number): string {
  if (!(t > 0)) return zero;
  const p = (18 + 82 * Math.sqrt(Math.min(1, t))) / 100;
  const z = hexToRgb(zero);
  const h = hexToRgb(heat);
  return rgbToHex([0, 1, 2].map((i) => h[i] * p + z[i] * (1 - p)) as RGB);
}
