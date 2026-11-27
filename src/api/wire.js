// Same peer contract as core/indexus/wire.go; checked by shared wire fixtures.
export const MAX_READ_LOCATIONS = 1024;
export const MAX_CONTENT_RECORDS = 10000;
export const MAX_CONTENT_PARTS = 1024;
export const MAX_CONTENT_BYTES = 64 << 20;
export const CONTENT_LOCATION_LENGTH = 16;
export const SETS_PRECISION = 32;
export const CONTENT_HEADERS = Object.freeze({
  decodedBytes: "X-Indexus-Decoded-Bytes",
  sha256: "X-Indexus-Sha256",
  storedEncoding: "X-Indexus-Stored-Encoding",
});
