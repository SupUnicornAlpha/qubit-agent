export * from "./types";
export { providerRegistry } from "./registry";
export { providerResolver } from "./resolver";
export { bootstrapProviders } from "./bootstrap";

/**
 * 公共表达式引擎 —— provider 抽象的"工具子模块"。
 *
 * 历史：qlib-expr 在 P0 时被放在 `impls/factor/qlib-expr/`，导致 service 层
 * 想做 dry-run / 离线评估时只能直接 import 实现文件，破坏 §5.4 契约
 * （"业务模块不允许直接 import 具体实现"）。
 *
 * 这里把 lexer/parser/evaluator 升格为 provider 的公共能力，service 层只需
 * `import { parseQlibExpr, evalQlibExpr, type PriceSeries } from '../provider'`，
 * 无需穿透到 `impls/` 路径。文件物理位置维持现状（实现已稳定，移动文件代价大于收益）。
 */
export {
  parse as parseQlibExpr,
  ExprParseError,
  type Ast as QlibExprAst,
} from "./impls/factor/qlib-expr/parser";
export {
  evalExpr as evalQlibExpr,
  ExprEvalError,
  type PriceSeries,
} from "./impls/factor/qlib-expr/evaluator";
export { ExprLexError } from "./impls/factor/qlib-expr/lexer";
