# Anthropic FSI 内容包

基于 [Claude for Financial Services](https://github.com/anthropics/financial-services) 的 Skills 与工作流，**默认随 QUBIT 启用**，无需配置环境变量。

## 开箱即用

1. 克隆本仓库后，若 `vendor/` 已有 Skills，直接启动即可。
2. 若 `vendor/` 为空（例如浅克隆未拉取 LFS/子目录），运行一次同步：

```bash
./scripts/sync-fsi-vendor.sh
```

脚本会按顺序查找内容来源：`FSI_SOURCE` 环境变量 → `financial-services` git submodule → 浅克隆上游仓库。

## 配置（推荐编辑文件，而非环境变量）

`content-packs/anthropic-fsi/settings.json`：

```json
{
  "enabled": true,
  "enabledBundles": ["quant-research"],
  "applyAgentMappings": true
}
```

| 字段 | 说明 |
|------|------|
| `enabled` | 总开关，默认 `true` |
| `enabledBundles` | `quant-research` = 权益研究 + 财务建模核心 |
| `applyAgentMappings` | 启动时合并 `skillsJson` |

关闭：`"enabled": false`，或临时 `QUBIT_FSI_DISABLED=true`。

## 内容目录

| 路径 | 说明 |
|------|------|
| `vendor/` | **提交到本仓库**的 SKILL.md / Playbook 副本（开箱即用） |
| `financial-services/` | 可选 **git submodule**，便于 `sync-fsi-vendor.sh` 更新 |
| `manifest.json` | Bundle、角色融合、MCP 目录、Schema |
| `settings.json` | 本地/部署配置 |

## 从上游更新

```bash
# 方式 A：使用 submodule
git submodule update --init content-packs/anthropic-fsi/financial-services
./scripts/sync-fsi-vendor.sh --force

# 方式 B：指定本地路径
FSI_SOURCE=/path/to/financial-services ./scripts/sync-fsi-vendor.sh --force
```

## API

`GET /api/v1/fsi/catalog` — 目录、角色映射、steering 示例、内容是否就绪。

## 环境变量（仅覆盖，可选）

| 变量 | 作用 |
|------|------|
| `QUBIT_FSI_DISABLED=true` | 临时关闭 |
| `QUBIT_FSI_BUNDLES` | 覆盖 bundle 列表 |
| `QUBIT_FSI_CONTENT_ROOT` | 覆盖内容根（高级） |
