-- Rollback Self-Evolving Agent P8（详见 0065_self_evolve_p8_auto_installer.sql）

DROP INDEX IF EXISTS `idx_auto_installer_run_project`;
DROP TABLE IF EXISTS `auto_installer_run`;

DROP INDEX IF EXISTS `idx_auto_install_proposal_gap`;
DROP INDEX IF EXISTS `idx_auto_install_proposal_gap_pending`;
DROP INDEX IF EXISTS `idx_auto_install_proposal_project_state`;
DROP TABLE IF EXISTS `auto_install_proposal`;
