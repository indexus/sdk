// The only copy toward WebGL: weather and the map composite share it.

export function copyTexture(
  gl,
  texture,
  pixels,
  { width, height, format, type, x = 0, y = 0, replace = false } = {},
) {
  if (!gl || !texture) throw Error("copy target required");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (replace) gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, format, type, pixels);
  else if (width != null)
    gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, format, type, pixels);
  else gl.texImage2D(gl.TEXTURE_2D, 0, format, format, type, pixels);
}
