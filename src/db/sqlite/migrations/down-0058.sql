-- 回滚脚本：手动执行（drizzle 自身不支持自动 down）。
-- 配套 0058_environment_manager_p1.sql。
DROP INDEX IF EXISTS `idx_env_install_log_status_started`;
DROP INDEX IF EXISTS `idx_env_install_log_kind_pkg_started`;
DROP TABLE IF EXISTS `env_install_log`;

DROP INDEX IF EXISTS `idx_env_registry_kind_status_cap`;
DROP INDEX IF EXISTS `idx_env_registry_kind_pkg`;
DROP TABLE IF EXISTS `env_registry`;
