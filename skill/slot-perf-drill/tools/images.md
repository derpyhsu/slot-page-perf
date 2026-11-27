# images

Part of [slot-perf-drill](../SKILL.md); its Rules apply.

`evaluate_script`: `async () => (await __slotDrill.images()).summary`, then `() => __slotDrill.last` with `filePath` `runs/<run>/drill/images.json`.

- Fetches each loaded texture's picture file again (normally from the HTTP cache) and reads its blocks: PNG text, Exif, XMP and private chunks, JPEG APP and comment segments, WebP EXIF and XMP. Lists files carrying `minKb` (default 20) or more that can go without changing a pixel, and files larger than their raw pixels (over 4 bytes a pixel). Colour profiles, JFIF and Exif are kept (Exif may hold the orientation).
- Prints block types, keys and sizes only, never what is inside a block. File names only, no query.
- For a build or project folder instead of a page: `node drill/images.js <folder>` (same parser).
