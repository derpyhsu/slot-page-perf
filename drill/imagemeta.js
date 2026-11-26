// What a PNG, JPEG or WebP file holds besides the picture: metadata blocks by kind and size, and
// which of them can go without changing a pixel. Only block types, their key or signature, and
// sizes come out; the text inside a block (document IDs, paths, comments) is never read out.
// drill/page.js carries the same function for files fetched on the page; test/drill-smoke.js checks
// that both give the same answer.
"use strict";

function imageMeta(u8) {
  var out = { type: null, w: null, h: null, bytes: u8.length, meta: [], removable: 0 };
  var be16 = function (i) { return (u8[i] << 8) | u8[i + 1]; };
  var be32 = function (i) { return ((u8[i] << 24) >>> 0) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3]; };
  var le32 = function (i) { return u8[i] + (u8[i + 1] << 8) + (u8[i + 2] << 16) + ((u8[i + 3] << 24) >>> 0); };
  var ascii = function (i, n) { var s = ""; for (var k = 0; k < n && i + k < u8.length; k += 1) { var c = u8[i + k]; if (c === 0) break; s += c >= 32 && c < 127 ? String.fromCharCode(c) : "?"; } return s; };
  var add = function (kind, key, size, removable) {
    out.meta.push({ kind: kind, key: key || undefined, bytes: size, removable: removable || undefined });
    if (removable) out.removable += size;
  };
  if (u8.length > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    out.type = "png";
    var KEEP = { IHDR: 1, PLTE: 1, IDAT: 1, IEND: 1, tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1, sBIT: 1, pHYs: 1, bKGD: 1, hIST: 1, sPLT: 1, acTL: 1, fcTL: 1, fdAT: 1 };
    for (var p = 8; p + 12 <= u8.length;) {
      var len = be32(p);
      var type = ascii(p + 4, 4);
      if (type === "IHDR") { out.w = be32(p + 8); out.h = be32(p + 12); }
      var size = 12 + len;
      if (type === "tEXt" || type === "zTXt" || type === "iTXt") add(type, ascii(p + 8, 79), size, true);
      else if (type === "eXIf" || type === "tIME") add(type, null, size, true);
      else if (type === "iCCP") add(type, ascii(p + 8, 79), size, false);
      else if (!KEEP[type] && /^[a-z]/.test(type)) add(type, null, size, true);
      if (type === "IEND") break;
      p += size;
    }
  } else if (u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8) {
    out.type = "jpeg";
    for (var q = 2; q + 4 <= u8.length;) {
      if (u8[q] !== 0xff) break;
      var m = u8[q + 1];
      if (m === 0xd9 || m === 0xda) break;
      if (m === 0xff || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { q += m === 0xff ? 1 : 2; continue; }
      var sl = be16(q + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) { out.h = be16(q + 5); out.w = be16(q + 7); }
      var seg = 2 + sl;
      if (m >= 0xe0 && m <= 0xef) {
        var sig = ascii(q + 4, 32);
        var n = m - 0xe0;
        if (n === 0) add("APP0", sig, seg, false);
        else if (n === 1 && /^Exif/.test(sig)) add("APP1", "Exif", seg, false);
        else if (n === 1) add("APP1", sig.indexOf("adobe") >= 0 ? "XMP" : sig, seg, true);
        else if (n === 2) add("APP2", sig, seg, false);
        else if (n === 13) add("APP13", sig, seg, true);
        else if (n === 14) add("APP14", sig, seg, false);
        else add("APP" + n, sig, seg, true);
      } else if (m === 0xfe) add("COM", null, seg, true);
      q += seg;
    }
  } else if (u8.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    out.type = "webp";
    for (var r = 12; r + 8 <= u8.length;) {
      var ct = ascii(r, 4);
      var cl = le32(r + 4);
      var cs = 8 + cl + (cl & 1);
      if (ct === "VP8X") { out.w = 1 + (u8[r + 12] | (u8[r + 13] << 8) | (u8[r + 14] << 16)); out.h = 1 + (u8[r + 15] | (u8[r + 16] << 8) | (u8[r + 17] << 16)); }
      else if (ct === "EXIF" || ct === "XMP ") add(ct.trim(), null, cs, true);
      else if (ct === "ICCP") add(ct, null, cs, false);
      r += cs;
    }
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) module.exports = { imageMeta: imageMeta };
