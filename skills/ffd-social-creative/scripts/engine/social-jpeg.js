/** Bound intrinsic dimensions before a generated JPEG reaches a native decoder. */
export function safeSocialJpeg(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)
        return false;
    let p = 2, found = false;
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (p < bytes.length - 2) {
        if (bytes[p++] !== 0xff)
            return false;
        while (p < bytes.length && bytes[p] === 0xff)
            p++;
        if (p >= bytes.length)
            return false;
        const marker = bytes[p++];
        if (marker === 0x00 || marker === 0xd8 || marker === 0xd9)
            return false;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
            continue;
        if (p + 2 > bytes.length)
            return false;
        const length = (bytes[p] << 8) | bytes[p + 1];
        if (length < 2 || p + length > bytes.length)
            return false;
        if (sof.has(marker)) {
            if (length < 8)
                return false;
            const height = (bytes[p + 3] << 8) | bytes[p + 4], width = (bytes[p + 5] << 8) | bytes[p + 6], components = bytes[p + 7];
            if (!height || !width || height > 8192 || width > 8192 || height * width > 16_777_216 || components < 1 || components > 4 || length < 8 + 3 * components)
                return false;
            found = true;
        }
        if (marker === 0xda)
            return found && length >= 6;
        p += length;
    }
    return false;
}
