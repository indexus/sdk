// Match the whole field using ordered, non-overlapping literal fragments.
// The star can consume any text, including a slash, a newline or no text.
function starGlob(pattern) {
  if (/[?\[\]{}\\]/u.test(pattern) || pattern.includes("**"))
    throw new RangeError("Supported glob syntax: literals and single stars");
  const parts = pattern.split("*");
  const first = parts[0], last = parts.at(-1);

  return function match(text) {
    if (parts.length === 1) return text === first;
    if (!text.startsWith(first) || !text.endsWith(last)) return false;
    let offset = first.length;
    const end = text.length - last.length;
    for (let i = 1; i < parts.length - 1; i++) {
      const pos = text.indexOf(parts[i], offset);
      if (pos < 0) return false;
      offset = pos + parts[i].length;
      if (offset > end) return false;
    }
    return offset <= end;
  };
}

const star = Symbol("*"), single = Symbol("?");
const escapable = "*?[]{}\\";

function codepointGlob(pattern) {
  const tokens = [];
  let escape = false;
  for (const ch of pattern) {
    if (escape) {
      if (!escapable.includes(ch)) throw new RangeError("Expected an escaped glob metacharacter");
      tokens.push(ch);
      escape = false;
    } else if (ch === "\\") {
      escape = true;
    } else if (ch === "*") {
      if (tokens.at(-1) === star) throw new RangeError("Adjacent glob stars are unsupported");
      tokens.push(star);
    } else if ("[]{}".includes(ch)) {
      throw new RangeError("Escape brackets and braces to match them literally");
    } else {
      tokens.push(ch === "?" ? single : ch);
    }
  }
  if (escape) throw new RangeError("Incomplete glob escape");

  return text => {
    // states[i] records whether the consumed text matches the first i tokens.
    const states = new Uint8Array(tokens.length + 1);
    states[0] = 1;
    if (tokens[0] === star) states[1] = 1;
    for (const ch of text) {
      let previous = states[0];
      states[0] = 0;
      for (let i = 0; i < tokens.length; i++) {
        const old = states[i + 1], token = tokens[i];
        states[i + 1] = token === star ? old || states[i] : previous && (token === single || token === ch);
        previous = old;
      }
    }
    return states[tokens.length] === 1;
  };
}

export function glob(select, pattern, { syntax = "star" } = {}) {
  if (typeof select !== "function" || typeof pattern !== "string")
    throw new TypeError("Expected a selector and a string glob");
  if (syntax !== "star" && syntax !== "codepoint") throw new RangeError("Unknown glob syntax");
  const compiled = syntax === "codepoint" ? codepointGlob(pattern) : starGlob(pattern);
  function match(text) {
    if (typeof text !== "string") throw new TypeError("Expected a string glob field or array element");
    return compiled(text);
  }
  return row => {
    const value = select(row);
    if (value == null) return false;
    if (!Array.isArray(value)) return match(value);
    let found = false;
    for (const text of value) {
      if (match(text)) found = true;
    }
    return found;
  };
}
