# Fonts (server-side rendering)

Satori renders text from **font buffers**, not CSS `@font-face`. `src/lib/fonts.ts`
reads these files from this folder at render time. The font binaries are **not
committed** — they are licensed assets (`.gitignore` excludes everything here
except this README).

## Required files (drop the licensed `.ttf` files here)

| File                          | `name` in fonts.ts | Weight | Role          |
| ----------------------------- | ------------------ | ------ | ------------- |
| `HankenGrotesk-Regular.ttf`   | `body`             | 400    | Body text     |
| `HankenGrotesk-SemiBold.ttf`  | `body`             | 600    | Body emphasis |
| `Fraunces-Regular.ttf`        | `display`          | 400    | Display/title |

The `fontFamily` stored on each design's `text_fields` must match a `name` above
(`body` or `display`).

## Licensing

Keep the license record for each font alongside your records (per the project's
font-licensing rule). Use only fonts whose license permits server-side
rasterization and commercial distribution of the rendered output. Hanken Grotesk
and Fraunces are both available under the SIL Open Font License (OFL).
