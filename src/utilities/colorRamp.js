// Colour ramps without d3: the colour parsing, RGB interpolation and
// piecewise linear scale of d3-color 3.1.1, d3-interpolate 3.0.2 and
// d3-scale 4.0.3 (ISC, Copyright 2010-2026 Mike Bostock), reduced to what the
// heat layer uses and kept operation for operation, so that the strings and
// channel values are the ones d3 gave (colorRamp.test.mjs compares them with
// d3 output frozen in testdata/colorRamp.d3.json).

const reI = "\\s*([+-]?\\d+)\\s*";
const reN = "\\s*([+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?)\\s*";
const reP = "\\s*([+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?)%\\s*";
const reHex = /^#([0-9a-f]{3,8})$/;
const reRgbInteger = new RegExp(`^rgb\\(${reI},${reI},${reI}\\)$`);
const reRgbPercent = new RegExp(`^rgb\\(${reP},${reP},${reP}\\)$`);
const reRgbaInteger = new RegExp(`^rgba\\(${reI},${reI},${reI},${reN}\\)$`);
const reRgbaPercent = new RegExp(`^rgba\\(${reP},${reP},${reP},${reN}\\)$`);
const reHslPercent = new RegExp(`^hsl\\(${reN},${reP},${reP}\\)$`);
const reHslaPercent = new RegExp(`^hsla\\(${reN},${reP},${reP},${reN}\\)$`);

// CSS named colours (d3-color's table), "name:rrggbb" separated by spaces.
const NAMED_TABLE =
  "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff " +
  "beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff " +
  "blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 " +
  "chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c " +
  "cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 " +
  "darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b " +
  "darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 " +
  "darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f " +
  "darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 " +
  "deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 " +
  "floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff " +
  "gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 " +
  "honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c " +
  "lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd " +
  "lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 " +
  "lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a " +
  "lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 " +
  "lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 " +
  "magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd " +
  "mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee " +
  "mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 " +
  "midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead " +
  "navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 " +
  "orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee " +
  "palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb " +
  "plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 " +
  "rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 " +
  "seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb " +
  "slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f " +
  "steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 " +
  "violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 " +
  "yellowgreen:9acd32";

let named = null;

function namedColor(name) {
  if (named === null) {
    named = new Map();
    for (const entry of NAMED_TABLE.split(" ")) {
      const [key, hex] = entry.split(":");
      named.set(key, parseInt(hex, 16));
    }
  }
  return named.get(name);
}

const rgb = (r, g, b, opacity) => ({ r: +r, g: +g, b: +b, opacity: +opacity });
const rgbn = (n) => rgb((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 1);

function rgba(r, g, b, a) {
  if (a <= 0) r = g = b = NaN;
  return rgb(r, g, b, a);
}

function hsla(h, s, l, a) {
  if (a <= 0) h = s = l = NaN;
  else if (l <= 0 || l >= 1) h = s = NaN;
  else if (s <= 0) h = NaN;
  return { h: +h, s: +s, l: +l, opacity: +a };
}

/**
 * d3.color(format): `{r, g, b, opacity}` for an rgb, hex or named colour (or
 * "transparent"), `{h, s, l, opacity}` for an hsl one (no `r`, like a d3 Hsl),
 * null when the string is not a colour. Channels are not rounded or clamped.
 */
export function parseColor(format) {
  let m, l;
  format = (format + "").trim().toLowerCase();
  if ((m = reHex.exec(format))) {
    l = m[1].length;
    m = parseInt(m[1], 16);
    if (l === 6) return rgbn(m);
    if (l === 3) {
      return rgb(
        ((m >> 8) & 0xf) | ((m >> 4) & 0xf0),
        ((m >> 4) & 0xf) | (m & 0xf0),
        ((m & 0xf) << 4) | (m & 0xf),
        1,
      );
    }
    if (l === 8)
      return rgba((m >> 24) & 0xff, (m >> 16) & 0xff, (m >> 8) & 0xff, (m & 0xff) / 0xff);
    if (l === 4) {
      return rgba(
        ((m >> 12) & 0xf) | ((m >> 8) & 0xf0),
        ((m >> 8) & 0xf) | ((m >> 4) & 0xf0),
        ((m >> 4) & 0xf) | (m & 0xf0),
        (((m & 0xf) << 4) | (m & 0xf)) / 0xff,
      );
    }
    return null;
  }
  if ((m = reRgbInteger.exec(format))) return rgb(m[1], m[2], m[3], 1);
  if ((m = reRgbPercent.exec(format))) {
    return rgb((m[1] * 255) / 100, (m[2] * 255) / 100, (m[3] * 255) / 100, 1);
  }
  if ((m = reRgbaInteger.exec(format))) return rgba(m[1], m[2], m[3], m[4]);
  if ((m = reRgbaPercent.exec(format))) {
    return rgba((m[1] * 255) / 100, (m[2] * 255) / 100, (m[3] * 255) / 100, m[4]);
  }
  if ((m = reHslPercent.exec(format))) return hsla(m[1], m[2] / 100, m[3] / 100, 1);
  if ((m = reHslaPercent.exec(format))) return hsla(m[1], m[2] / 100, m[3] / 100, m[4]);
  const n = namedColor(format);
  if (n !== undefined) return rgbn(n);
  return format === "transparent" ? rgb(NaN, NaN, NaN, 0) : null;
}

/* From FvD 13.37, CSS Color Module Level 3 */
function hsl2rgb(h, m1, m2) {
  return (
    (h < 60
      ? m1 + ((m2 - m1) * h) / 60
      : h < 180
        ? m2
        : h < 240
          ? m1 + ((m2 - m1) * (240 - h)) / 60
          : m1) * 255
  );
}

/** d3.rgb(value): an rgb colour, NaN channels when `value` is not a colour. */
function toRgb(value) {
  const c = parseColor(value);
  if (c === null) return rgb(NaN, NaN, NaN, NaN);
  if (c.r !== undefined) return c;
  const h = (c.h % 360) + (c.h < 0) * 360;
  const s = isNaN(h) || isNaN(c.s) ? 0 : c.s;
  const l = c.l;
  const m2 = l + (l < 0.5 ? l : 1 - l) * s;
  const m1 = 2 * l - m2;
  return rgb(
    hsl2rgb(h >= 240 ? h - 240 : h + 120, m1, m2),
    hsl2rgb(h, m1, m2),
    hsl2rgb(h < 120 ? h + 240 : h - 120, m1, m2),
    c.opacity,
  );
}

const clampa = (a) => (isNaN(a) ? 1 : Math.max(0, Math.min(1, a)));
const clampi = (value) => Math.max(0, Math.min(255, Math.round(value) || 0));

/** d3 rgb.toString(): "rgb(r, g, b)", or "rgba(r, g, b, a)" below full opacity. */
function formatRgb(r, g, b, opacity) {
  const a = clampa(opacity);
  return `${a === 1 ? "rgb(" : "rgba("}${clampi(r)}, ${clampi(g)}, ${clampi(b)}${a === 1 ? ")" : `, ${a})`}`;
}

const constant = (x) => () => x;
const linear = (a, d) => (t) => a + t * d;

function nogamma(a, b) {
  const d = b - a;
  return d ? linear(a, d) : constant(isNaN(a) ? b : a);
}

/** d3.interpolateRgb(a, b): t → the colour string between a and b, per channel in RGB. */
export function interpolateRgb(a, b) {
  const start = toRgb(a);
  const end = toRgb(b);
  const r = nogamma(start.r, end.r);
  const g = nogamma(start.g, end.g);
  const bl = nogamma(start.b, end.b);
  const opacity = nogamma(start.opacity, end.opacity);
  return (t) => formatRgb(r(t), g(t), bl(t), opacity(t));
}

function normalize(a, b) {
  return (b -= a = +a) ? (x) => (x - a) / b : constant(isNaN(b) ? NaN : 0.5);
}

function ascending(a, b) {
  return a == null || b == null ? NaN : a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN;
}

// d3.bisectRight
function bisectRight(a, x, lo, hi) {
  if (lo < hi) {
    if (ascending(x, x) !== 0) return hi;
    do {
      const mid = (lo + hi) >>> 1;
      if (ascending(a[mid], x) <= 0) lo = mid + 1;
      else hi = mid;
    } while (lo < hi);
  }
  return lo;
}

function bimap(domain, range, interpolate) {
  let d0 = domain[0];
  let r0 = range[0];
  const d1 = domain[1];
  const r1 = range[1];
  if (d1 < d0) ((d0 = normalize(d1, d0)), (r0 = interpolate(r1, r0)));
  else ((d0 = normalize(d0, d1)), (r0 = interpolate(r0, r1)));
  return (x) => r0(d0(x));
}

function polymap(domain, range, interpolate) {
  const j = Math.min(domain.length, range.length) - 1;
  const d = new Array(j);
  const r = new Array(j);
  if (domain[j] < domain[0]) {
    domain = domain.slice().reverse();
    range = range.slice().reverse();
  }
  for (let i = 0; i < j; i++) {
    d[i] = normalize(domain[i], domain[i + 1]);
    r[i] = interpolate(range[i], range[i + 1]);
  }
  return (x) => {
    const i = bisectRight(domain, x, 1, j) - 1;
    return r[i](d[i](x));
  };
}

/**
 * d3.scaleLinear().domain(domain).range(colours).interpolate(d3.interpolateRgb),
 * with .clamp(true) when `clamp`: value → "rgb(r, g, b)", undefined for a
 * value that is null or not a number. Piecewise linear in RGB between the
 * stops; outside the domain it extrapolates (channels clamped to 0..255) or,
 * clamped, holds the end colours. Read-only: domain(), range() and clamp()
 * return the settings, copy() an equal ramp.
 */
export function rgbRamp(domain, range, { clamp = false } = {}) {
  domain = Array.from(domain, (d) => +d);
  range = Array.from(range);
  const n = Math.min(domain.length, range.length);
  let low = domain[0];
  let high = domain[n - 1];
  if (low > high) [low, high] = [high, low];
  const clamper = clamp ? (x) => Math.max(low, Math.min(high, x)) : (x) => x;
  let output = null;
  function ramp(x) {
    if (x == null || isNaN((x = +x))) return undefined;
    output ??= (n > 2 ? polymap : bimap)(domain, range, interpolateRgb);
    return output(clamper(x));
  }
  ramp.domain = () => domain.slice();
  ramp.range = () => range.slice();
  ramp.clamp = () => clamp;
  ramp.copy = () => rgbRamp(domain, range, { clamp });
  return ramp;
}
