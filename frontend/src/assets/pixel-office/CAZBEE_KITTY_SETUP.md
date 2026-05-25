# CazBee Kitty (CC0)

This directory is the staging area for the optional [CazBee Kitty](https://caz-bee.itch.io/kitty) asset pack, used as an alternative to our programmatic cats.

## Why this matters

- Our default cats are 22×30 programmatic sprites, fully animated, but stylistically a bit blocky.
- CazBee Kitty is a 32×32 hand-pixelled animated cat by [CazBee](https://caz-bee.itch.io/) released under **CC0 1.0 Universal** (no attribution required, but we still credit it in `docs/PIXEL_OFFICE_CREDITS.md`).
- Once the asset is downloaded into this directory, the pixel office can run with CazBee-Kitty-style cats (single Ginger orange, or palette-swapped 8 breeds) via a runtime toggle.

## Manual download (one-time)

The itch.io download is "name your own price" — you can enter `0` and get a free download. (Required because itch.io blocks scripted direct downloads.)

1. Visit https://caz-bee.itch.io/kitty
2. Click **Download Now**, leave price at `0`, click **No thanks, just take me to the downloads**.
3. Download both files:
   - `kitty.png` (3.6 kB — the sprite sheet)
   - `kitty.aseprite` (8.2 kB — optional source, useful for inspecting frame layout)
4. Move both files into the gitignored `raw/CazBee-Kitty/` staging dir (create it):

```
frontend/src/assets/pixel-office/
  CAZBEE_KITTY_SETUP.md   (this file, committed)
  raw/CazBee-Kitty/       (gitignored — assets live here)
    kitty.png             (you just downloaded)
    kitty.aseprite        (you just downloaded, optional)
```

5. Re-run `bun run build:office-atlas` to bake CazBee frames into the office atlas. (The build script will silently skip CazBee frames if `kitty.png` is missing, so existing builds still work.)

## What the sprite sheet contains

According to the asset page, `kitty.png` is a vertical strip of **8 animations, each on its own row, 32×32 px per frame.** Frame count per row is determined at integration time by reading the PNG dimensions. The exact animation order (idle/walk/jump/etc.) is to be confirmed by inspection — see `cazbeeKitty.ts` for the assumed mapping.

## License & credits

- **License**: Creative Commons Zero v1.0 Universal (public domain dedication).
- **Author**: CazBee — https://caz-bee.itch.io
- We display CazBee in the in-app credits modal whenever the CazBee Kitty mode is active, even though attribution is not legally required.
