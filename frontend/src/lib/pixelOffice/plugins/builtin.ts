import { getRenderConfig } from "../config";
import { drawBuiltinSceneBackground } from "../sceneBackground";
import { drawCitySkyline } from "../skylineArt";
import { drawSkylineImage, preloadSkylineImages } from "../skylineImages";
import { getSpriteAtlas } from "../spriteAtlas";
import type { PixelOfficeRegistry, SkylineDrawContext } from "../registry";
import type { CitySkyline } from "../types";

function skylineWithImageFallback(city: CitySkyline) {
  return (c: SkylineDrawContext) => {
    if (!drawSkylineImage(c, city)) {
      drawCitySkyline(c, city);
    }
  };
}

export function registerBuiltinPlugins(reg: PixelOfficeRegistry): void {
  preloadSkylineImages();

  reg.registerSkyline("shanghai", skylineWithImageFallback("shanghai"));

  reg.setSceneBackgroundRenderer((ctx, w, h, cityId, now) => {
    drawBuiltinSceneBackground(ctx, w, h, cityId, now, reg);
  });

  reg.registerSpriteProvider(
    {
      id: "builtin",
      getAtlas: () => getSpriteAtlas(getRenderConfig()),
      invalidate: () => {
        // spriteAtlas 按 atlasBuild 自动失效
      },
    },
    { default: true }
  );
}
