// Order IDs by Unicode code point, as in the Python export tool. JavaScript's
// default string order compares UTF-16 code units for supplementary characters.
export function compareIds(a, b) {
  let i = 0;
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i);
    const y = b.codePointAt(i);
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}
