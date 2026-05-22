import { getRenderConfig } from "../config";
import { drawBuiltinSceneBackground } from "../sceneBackground";
import { drawCitySkyline } from "../skylineArt";
import { getSpriteAtlas } from "../spriteAtlas";
import type { PixelOfficeRegistry } from "../registry";

export function registerBuiltinPlugins(reg: PixelOfficeRegistry): void {
  reg.registerSkyline("nyc", (c) => drawCitySkyline(c, "nyc"));
  reg.registerSkyline("shanghai", (c) => drawCitySkyline(c, "shanghai"));
  reg.registerSkyline("hongkong", (c) => drawCitySkyline(c, "hongkong"));

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
