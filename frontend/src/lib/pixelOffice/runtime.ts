import { registerBuiltinPlugins } from "./plugins/builtin";
import { PixelOfficeRegistry, type PixelOfficePlugin } from "./registry";

let registry: PixelOfficeRegistry | null = null;
const extraPlugins: PixelOfficePlugin[] = [];

/** 注册扩展插件（在首次 getPixelOfficeRegistry 之前调用） */
export function registerPixelOfficePlugin(plugin: PixelOfficePlugin): void {
  if (registry) {
    plugin.register(registry);
    return;
  }
  extraPlugins.push(plugin);
}

export function getPixelOfficeRegistry(): PixelOfficeRegistry {
  if (!registry) {
    registry = new PixelOfficeRegistry();
    registerBuiltinPlugins(registry);
    const sorted = [...extraPlugins].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const p of sorted) p.register(registry);
  }
  return registry;
}

/** 测试或热重载时重置 */
export function resetPixelOfficeRuntime(): void {
  registry = null;
}
