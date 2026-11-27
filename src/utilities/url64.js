// URL64 carries opaque transport bytes; peers and zones use the Indexus alphabet.
// btoa and atob exist in browsers, workers and Node, so no Buffer polyfill.

function encodeUrl64(input) {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    throw new Error("Input must be a string or Uint8Array");
  }
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** @returns {Uint8Array} */
function decodeUrl64(encoded) {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export { encodeUrl64, decodeUrl64 };
