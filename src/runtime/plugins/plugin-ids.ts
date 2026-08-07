/**
 * Stable plugin ids — isolated module to avoid circular TDZ when registry /
 * official-packs / barrel index load each other under bun --watch.
 */
export const INTERNET_PLUGIN_ID = "builtin:internet";
export const QUANT_DATA_PLUGIN_ID = "builtin:quant-data";
export const FUTU_CONNECTOR_PLUGIN_ID = "connector:futu";
export const GITHUB_CONNECTOR_PLUGIN_ID = "connector:github";
export const GENERIC_OAUTH_PLUGIN_ID = "connector:generic-oauth2";
