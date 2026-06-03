/**
 * 语言包注册中心：通过 Vite `import.meta.glob` 在编译期自动收集
 * `./dictionaries/*.ts` 下所有 `export default` 的 `LocalePack`。
 *
 * 新增语言只需在 `dictionaries/` 下创建一个新文件，无需改动此文件。
 */
import type { LocalePack } from "./types";

interface PackModule {
  default?: LocalePack;
}

const modules = import.meta.glob<PackModule>("./dictionaries/*.ts", {
  eager: true,
});

const registry = new Map<string, LocalePack>();

for (const [path, mod] of Object.entries(modules)) {
  const pack = mod?.default;
  if (!pack || !pack.id || !pack.translations) {
    if (typeof console !== "undefined") {
      console.warn(`[i18n] 跳过非法语言包文件：${path}（缺少 id / translations）`);
    }
    continue;
  }
  if (registry.has(pack.id)) {
    console.warn(`[i18n] 语言代码冲突：${pack.id}（来自 ${path}），后者将覆盖前者`);
  }
  registry.set(pack.id, pack);
}

/** 已注册的所有语言包，按 id 升序稳定输出（便于下拉菜单展示顺序一致）。 */
export const REGISTERED_LOCALES: LocalePack[] = Array.from(registry.values()).sort((a, b) =>
  a.id.localeCompare(b.id),
);

/** 根据 id 取语言包；找不到返回 `undefined`。 */
export function findLocalePack(id: string): LocalePack | undefined {
  return registry.get(id);
}

/** 获取注册中心的全部 id 列表。 */
export function getRegisteredLocaleIds(): string[] {
  return REGISTERED_LOCALES.map((p) => p.id);
}
