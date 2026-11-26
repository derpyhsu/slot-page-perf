#!/usr/bin/env node
// Usage: node test/images-smoke.js
// Builds small PNG, JPEG and WebP files with metadata blocks, then checks drill/imagemeta.js, the
// copy inside drill/page.js (images()), and the drill/images.js folder scan agree and never print
// block text.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");
const { imageMeta } = require("../drill/imagemeta");

const SECRET = "xmp.did:SECRET-DOCUMENT-ID";
const be32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type, data) => Buffer.concat([be32(data.length), Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
const ihdr = Buffer.concat([be32(786), be32(608), Buffer.from([8, 6, 0, 0, 0])]);
// 786×608 with a 600 KB XMP text chunk: bigger than its raw pixels would be at 1 byte a pixel.
const xmp = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(SECRET.repeat(24000), "latin1")]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("iCCP", Buffer.from("ICC Profile\0\0abc", "latin1")), chunk("iTXt", xmp), chunk("IDAT", Buffer.alloc(1000)), chunk("IEND", Buffer.alloc(0))]);
const seg = (m, data) => Buffer.concat([Buffer.from([0xff, m, ((data.length + 2) >> 8) & 255, (data.length + 2) & 255]), data]);
const sof = Buffer.from([8, 0x01, 0x60, 0x02, 0x80, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01", "latin1")), seg(0xe1, Buffer.from("Exif\0\0" + "x".repeat(200), "latin1")), seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0" + SECRET.repeat(1500), "latin1")), seg(0xed, Buffer.from("Photoshop 3.0\0" + "y".repeat(30000), "latin1")), seg(0xc0, sof), Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
const riff = (type, data) => Buffer.concat([Buffer.from(type, "ascii"), Buffer.from([data.length & 255, (data.length >> 8) & 255, (data.length >> 16) & 255, (data.length >>> 24) & 255]), data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const vp8x = Buffer.from([0x0c, 0, 0, 0, 99, 0, 0, 49, 0, 0]);
const webpBody = Buffer.concat([Buffer.from("WEBP", "ascii"), riff("VP8X", vp8x), riff("XMP ", Buffer.from(SECRET.repeat(1200), "latin1")), riff("VP8L", Buffer.alloc(50))]);
const webp = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([webpBody.length & 255, (webpBody.length >> 8) & 255, (webpBody.length >> 16) & 255, 0]), webpBody]);

const p = imageMeta(new Uint8Array(png));
assert.ok(p.type === "png" && p.w === 786 && p.h === 608, "PNG size");
assert.ok(p.meta.find((m) => m.kind === "iTXt").key === "XML:com.adobe.xmp" && p.removable > 500000, "XMP chunk counted as removable");
assert.ok(p.meta.find((m) => m.kind === "iCCP").removable === undefined, "colour profile kept");
const j = imageMeta(new Uint8Array(jpg));
assert.ok(j.type === "jpeg" && j.w === 640 && j.h === 352, "JPEG size from SOF0: " + j.w + "x" + j.h);
assert.ok(j.meta.find((m) => m.key === "XMP").removable && j.meta.find((m) => m.kind === "APP13").removable && !j.meta.find((m) => m.key === "Exif").removable, "XMP and Photoshop blocks removable, Exif kept");
const w = imageMeta(new Uint8Array(webp));
assert.ok(w.type === "webp" && w.w === 100 && w.h === 50 && w.meta[0].kind === "XMP", "WebP size and XMP");
assert.ok(!JSON.stringify([p, j, w]).includes("SECRET"), "block text never read out");

// Folder scan.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-images-"));
fs.mkdirSync(path.join(dir, "native"));
fs.writeFileSync(path.join(dir, "native", "reel_frame.png"), png);
fs.writeFileSync(path.join(dir, "bg.jpg"), jpg);
fs.writeFileSync(path.join(dir, "clean.webp"), riff("RIFF", Buffer.alloc(4)));
const outCli = execFileSync(process.execPath, [path.join(__dirname, "..", "drill", "images.js"), dir], { encoding: "utf8" });
assert.ok(/^3 張圖，2 張/.test(outCli) && outCli.includes(path.join("native", "reel_frame.png")) && outCli.includes("iTXt XML:com.adobe.xmp") && !outCli.includes("SECRET"), "folder scan:\n" + outCli);

// The page copy: same answers, through images() on a page whose textures point at these files.
global.window = global;
class Texture2D {}
const tex = (url, w2, h2, name) => Object.assign(new Texture2D(), { nativeUrl: url, width: w2, height: h2, name });
const files = { "https://cdn.test/a/native/reel.png?t=secret": png, "https://cdn.test/a/native/bg.jpg": jpg };
global.cc = {
  ENGINE_VERSION: "2.4.9",
  Texture2D,
  director: { getScene: () => ({ name: "scene", children: [], _children: [] }) },
  renderer: { drawCalls: 0 },
  js: { getClassName: () => "Other" },
  assetManager: { assets: { forEach: (f) => [tex("https://cdn.test/a/native/reel.png?t=secret", 786, 608, "reel_frame"), tex("https://cdn.test/a/native/bg.jpg", 640, 352, "bg")].forEach(f) } },
};
global.fetch = async (u) => ({ ok: !!files[u], arrayBuffer: async () => files[u].buffer.slice(files[u].byteOffset, files[u].byteOffset + files[u].length) });
const pageSrc = fs.readFileSync(path.join(__dirname, "..", "drill", "page.js"), "utf8");
assert.strictEqual(eval(pageSrc)(), "drill ok");
const D = global.__slotDrill;
for (const b of [png, jpg, webp]) assert.deepStrictEqual(D.imageMeta(new Uint8Array(b)), imageMeta(new Uint8Array(b)), "page copy agrees");
(async () => {
  const r = await D.images();
  assert.strictEqual(r.rows[0].file, "reel.png", "file name only, no query");
  assert.ok(r.rows[0].name === "reel_frame" && r.rows[0].bpp > 1 && r.rows[0].removableKb > 500, "page scan finds the XMP");
  assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes("SECRET"), "no query or block text");
  console.log(r.summary.join("\n"));
  console.log("images smoke ok");
})().catch((e) => { console.error(e); process.exit(1); });
