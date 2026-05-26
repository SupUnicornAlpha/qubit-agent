-- P1-B (2026-05): 删除空 ProviderKind 在 provider_registry 中遗留的行
--
-- live_ems / market_data / llm / factor_miner 这 4 个 ProviderKind 实际没有任何
-- providerResolver.resolve 调用方（业务侧走 reia/broker-connector、llm-router、
-- 内嵌 factor-service 等绕过 Provider 抽象层），相关的占位 interface / 3 个
-- builtin impl / bootstrap 注册 / routes UI 枚举一起从代码删除。这条迁移把
-- bootstrap 之前 syncToDb 写入的旧行清掉，避免 schema enum 收紧后查询时报错。
--
-- SQLite 不支持 ALTER TABLE 改 CHECK / enum，drizzle 的 enum 也只在 TS 层；
-- DELETE 即可保证下次 syncToDb 不会再写回（bootstrap 已经不 register 它们了）。

DELETE FROM provider_registry WHERE kind IN ('live_ems', 'market_data', 'llm', 'factor_miner');
