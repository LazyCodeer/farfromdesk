import 'dart:typed_data';

/// Bound JPEG dimensions before an image is handed to a native decoder.
bool safeSocialJpeg(Uint8List bytes) {
  if (bytes.length < 4 ||
      bytes[0] != 255 ||
      bytes[1] != 216 ||
      bytes[bytes.length - 2] != 255 ||
      bytes.last != 217) {
    return false;
  }
  const sof = {
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf,
  };
  var p = 2, found = false;
  while (p < bytes.length - 2) {
    if (bytes[p++] != 255) return false;
    while (p < bytes.length && bytes[p] == 255) {
      p++;
    }
    if (p >= bytes.length) return false;
    final marker = bytes[p++];
    if (marker == 0 || marker == 0xd8 || marker == 0xd9) return false;
    if (marker == 1 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (p + 2 > bytes.length) return false;
    final length = (bytes[p] << 8) | bytes[p + 1];
    if (length < 2 || p + length > bytes.length) return false;
    if (sof.contains(marker)) {
      if (length < 8) return false;
      final height = (bytes[p + 3] << 8) | bytes[p + 4],
          width = (bytes[p + 5] << 8) | bytes[p + 6],
          components = bytes[p + 7];
      if (height == 0 ||
          width == 0 ||
          height > 8192 ||
          width > 8192 ||
          height * width > 16777216 ||
          components < 1 ||
          components > 4 ||
          length < 8 + 3 * components) {
        return false;
      }
      found = true;
    }
    if (marker == 0xda) return found && length >= 6;
    p += length;
  }
  return false;
}

/// Linear validation avoids a regular-expression stack overflow on large images.
bool validSocialBase64(String value) {
  if (value.isEmpty || value.length > 20000000 || value.length % 4 != 0) {
    return false;
  }
  var padding = 0;
  for (var i = 0; i < value.length; i++) {
    final c = value.codeUnitAt(i);
    if (c == 61) {
      padding++;
      if (padding > 2 || i < value.length - 2) return false;
      continue;
    }
    if (padding != 0 ||
        !(c >= 65 && c <= 90 ||
            c >= 97 && c <= 122 ||
            c >= 48 && c <= 57 ||
            c == 43 ||
            c == 47)) {
      return false;
    }
  }
  return true;
}
