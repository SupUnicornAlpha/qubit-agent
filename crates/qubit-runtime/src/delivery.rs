//! DeliveryEvaluator — thin Core engine over PolicySnapshot + EffectLedger (01 §10).

use qubit_protocol::{DeliveryStatus, DeliveryVerdict, EffectLedger, PolicySnapshot, TurnView};

/// Sole author of DeliveryVerdict in Core. Business predicates stay in snapshot DATA.
pub trait DeliveryEvaluator: Send + Sync {
    fn evaluate(
        &self,
        snap: &PolicySnapshot,
        ledger: &EffectLedger,
        turn: &TurnView,
    ) -> DeliveryVerdict;
}

#[derive(Debug, Default, Clone)]
pub struct LedgerDeliveryEvaluator;

impl DeliveryEvaluator for LedgerDeliveryEvaluator {
    fn evaluate(
        &self,
        snap: &PolicySnapshot,
        ledger: &EffectLedger,
        turn: &TurnView,
    ) -> DeliveryVerdict {
        if matches!(turn.state, qubit_protocol::TurnState::Cancelled) {
            return DeliveryVerdict {
                status: DeliveryStatus::Cancelled,
                reasons: vec!["turn_cancelled".into()],
            };
        }

        let mut reasons: Vec<String> = Vec::new();
        let mut soft: Vec<String> = Vec::new();

        if snap.recipe_key.is_none() {
            reasons.push("scenario_recipe_missing".into());
            let answer_ok = answer_schema_ok(
                &snap.completion.answer_schema.required_sections,
                ledger.answer_text.as_deref(),
            );
            if !answer_ok {
                soft.push("answer_schema_unsatisfied".into());
            }
            return DeliveryVerdict {
                status: DeliveryStatus::Partial,
                reasons: merge_unique(reasons, soft),
            };
        }

        let mut missing_artifacts = false;
        for art in &snap.completion.artifacts {
            let count = ledger.count_artifact(&art.key);
            if art.research_min_count > 0 && count < art.research_min_count {
                missing_artifacts = true;
                reasons.push(format!("missing_artifact:{}", art.key));
                continue;
            }
            if count < art.min_count {
                soft.push(format!(
                    "artifact_underfill:{}:{}/{}",
                    art.key, count, art.min_count
                ));
            }
        }

        let mut missing_caps = false;
        for req in &snap.completion.required_tools {
            let success = ledger
                .successful_tools
                .iter()
                .filter(|name| tool_matches_capability(name, &req.capability))
                .count() as u32;
            if success < req.min_success {
                missing_caps = true;
                reasons.push(format!("capability_not_succeeded:{}", req.capability));
            }
        }

        let answer_ok = answer_schema_ok(
            &snap.completion.answer_schema.required_sections,
            ledger.answer_text.as_deref(),
        );
        if !answer_ok {
            soft.push("answer_schema_unsatisfied".into());
        }

        let research_ok = !missing_artifacts && !missing_caps;
        let upgrade_ok = research_ok && soft.is_empty() && answer_ok;

        let status = if upgrade_ok {
            DeliveryStatus::Delivered
        } else if research_ok {
            DeliveryStatus::DeliveredWithGaps
        } else {
            DeliveryStatus::Partial
        };

        DeliveryVerdict {
            status,
            reasons: merge_unique(reasons, soft),
        }
    }
}

fn tool_matches_capability(tool_name: &str, capability: &str) -> bool {
    let name = tool_name.strip_prefix("tool/").unwrap_or(tool_name);
    let lower = name.to_ascii_lowercase();
    if name == capability || lower.contains(&capability.to_ascii_lowercase()) {
        return true;
    }
    // Loose capability aliases — keep in sync with Bun `REQUIRED_TOOL_ALIASES`.
    match capability {
        "screener" => {
            lower.contains("screener")
                || lower.contains("stock_screen")
                || lower.contains("portfolio.construct")
        }
        "get_quote" => {
            lower.contains("quote")
                || lower.contains("fetch_klines")
                || lower.contains("fetch_bars")
                || lower.contains("historical_prices")
                || lower.contains("technical_indicator")
                || lower.contains("get_stock_info")
                || lower.contains("market.snapshot")
                || lower.contains("market_service")
        }
        "news" => {
            lower.contains("news")
                || lower.contains("headline")
                || lower.contains("filing")
                || lower.contains("earnings")
                || lower.contains("announcement")
        }
        "recommendation.record" => {
            lower.contains("recommendation.record") || lower.contains("recommendation_record")
        }
        "order" => lower.contains("order.create_intent") || lower.contains("submit_order"),
        "risk" => {
            lower.contains("risk")
                || lower.contains("evaluate_risk")
                || lower.contains("order.create_intent")
        }
        "factor" => {
            lower.contains("factor.register")
                || lower.contains("factor.compute")
                || lower.contains("factor.evaluate")
        }
        _ => lower.starts_with(&capability.to_ascii_lowercase()),
    }
}

fn answer_schema_ok(required: &[String], text: Option<&str>) -> bool {
    if required.is_empty() {
        return true;
    }
    let Some(text) = text else {
        return false;
    };
    let lower = text.to_lowercase();
    required.iter().all(|section| {
        let needle = section.to_lowercase();
        lower.contains(&needle)
            || lower.contains(&format!("## {needle}"))
            || lower.contains(&format!("# {needle}"))
    })
}

fn merge_unique(a: Vec<String>, b: Vec<String>) -> Vec<String> {
    let mut out = a;
    for x in b {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}
