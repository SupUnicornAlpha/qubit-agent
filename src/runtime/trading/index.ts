/**
 * Trading domain route for intent, execution, risk and simulation.
 *
 * Market data is routed through Host because it is an external capability
 * boundary shared by quantitative engineering and trading.
 */
export * as execution from "./execution";
export * as reia from "./reia";
export * as trader from "./trader";
export * as risk from "./risk";
export * as attribution from "./attribution";
export * as simulation from "./simulation";
