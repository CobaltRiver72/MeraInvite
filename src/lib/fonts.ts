// Fonts for server-side rendering (Satori needs font buffers, not CSS @font-face).
// Put commercially-licensed .ttf/.otf files in /fonts at the repo root and keep
// the license records (per the project's font-licensing rule).
// The `fontFamily` stored on each design's text_fields must match a `name` below.
import fs from "node:fs";
import path from "node:path";

let cache: { name: string; data: Buffer; weight: 400 | 600; style: "normal" }[] | null = null;

export function loadFonts() {
  if (cache) return cache;
  const dir = path.join(process.cwd(), "fonts");
  cache = [
    { name: "body", data: fs.readFileSync(path.join(dir, "HankenGrotesk-Regular.ttf")), weight: 400, style: "normal" },
    { name: "body", data: fs.readFileSync(path.join(dir, "HankenGrotesk-SemiBold.ttf")), weight: 600, style: "normal" },
    { name: "display", data: fs.readFileSync(path.join(dir, "Fraunces-Regular.ttf")), weight: 400, style: "normal" },
  ];
  return cache;
}
