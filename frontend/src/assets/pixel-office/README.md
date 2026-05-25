# Pixel Office 美术资产说明

本目录托管像素办公室所需的图像资源。

| 子目录 | 是否入库 | 说明 |
|--------|----------|------|
| `skyline-*.png` | ✅ 入库 | 城市天际线背景图（已有）|
| `raw/` | ❌ 不入库（被 .gitignore 忽略）| 从 itch.io 下载的原始美术包解压目录 |
| `themes/<id>/` | ✅ 入库 | 由 `bun run build:office-atlas` 构建产物（atlas.png / atlas.json / manifest.ts）|
| `README.md` | ✅ 入库 | 本文件 |

> 总体计划与决策：[`docs/PIXEL_OFFICE_ART_UPGRADE_PLAN.md`](../../../../docs/PIXEL_OFFICE_ART_UPGRADE_PLAN.md)

---

## 1. 下载原始美术包（首次开发或更换机器）

两个包均来自 itch.io，「Name your own price」可填 0：

| # | 资产 | 协议 | URL | 解压目标目录 |
|---|------|------|-----|-------------|
| 1 | Antea Free Furniture Office Set | **CC-BY 4.0** | https://stcrbcn.itch.io/furniture-office-set | `raw/antea-furniture/` |
| 2 | 2dPig Pixel Office Asset Pack | **CC0** | https://2dpig.itch.io/pixel-office | `raw/2dpig-office/` |

### 操作步骤

1. 打开两个链接，分别点击「Download Now」→「No thanks, just take me to the downloads」→ 下载 zip
2. 在仓库根目录执行：
   ```bash
   mkdir -p frontend/src/assets/pixel-office/raw/antea-furniture
   mkdir -p frontend/src/assets/pixel-office/raw/2dpig-office
   ```
3. 把第 1 个 zip 解压到 `raw/antea-furniture/`，第 2 个 zip 解压到 `raw/2dpig-office/`
4. 验证：
   ```bash
   ls frontend/src/assets/pixel-office/raw/antea-furniture/   # 应能看到 .png 文件
   ls frontend/src/assets/pixel-office/raw/2dpig-office/      # 应能看到 .png 文件
   ```

> 已确认包体合计约 86 KB（37 KB + 49 KB）。
> 整个 `raw/` 目录由 `.gitignore` 忽略，**不会**误提交进 git。

---

## 2. 协议与署名（CC-BY 必读）

Antea 包是 **CC-BY 4.0**，必须在产品中给出署名（attribution），否则构成违约。具体落地位置（实施时）：

- 状态条旁极小灰字：`Art: Antea, 2dPig · Font: Ark Pixel`
- 工具栏「i」按钮 → `PixelOfficeCredits` 弹窗（完整链接 + 协议）
- 文档：`docs/PIXEL_OFFICE_CREDITS.md`

2dPig 是 **CC0**，可不署名，但仍建议出于礼貌一并列出。

---

## 3. 构建 atlas（Phase 1 实施后可用）

```bash
cd frontend
bun run build:office-atlas
```

构建脚本（[`frontend/scripts/build-office-atlas.ts`](../../../scripts/build-office-atlas.ts)，**待实施**）会：

1. 扫描 `raw/` 下所有 PNG
2. 按文件名关键词分类（desk / chair / monitor / bookshelf / plant / printer …）
3. 输出 `themes/modern/atlas.png` + `themes/modern/atlas.json` + `themes/modern/manifest.ts`
4. 打印未自动分类的精灵列表（需手动 override）

目标体积：atlas < 80 KB。

---

## 4. CI 与发版

- `bun run build:office-atlas` **不在 CI 中运行**——CI 直接使用入库的 atlas 产物
- 仅当 raw 资产更新（升级到新版本、新增包）时，开发者手动重跑并提交新的 atlas
- 后续若加入新主题（如 `cozy_plus`），同样产物入库，源码不入库
