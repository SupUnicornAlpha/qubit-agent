//! Prompt budget helpers.
//!
//! Prompt text is not ordinary prose: truncating a rule list or JSON example in
//! the middle can change the agent's behavior. This module therefore prefers
//! dropping complete low-value sections and records what happened in metadata.

use serde_json::{json, Value};

use qubit_protocol::{CompressMode, ContextSlotBudget};

#[derive(Clone, Debug)]
pub struct BudgetedPrompt {
    pub text: String,
    pub meta: Value,
}

#[derive(Clone, Debug)]
struct Section {
    heading: String,
    text: String,
    index: usize,
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

fn truncate_utf8(text: &str, max: usize) -> String {
    if char_len(text) <= max {
        return text.to_string();
    }
    text.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}

fn split_sections(text: &str) -> (String, Vec<Section>) {
    let mut intro = String::new();
    let mut sections = Vec::new();
    let mut current_heading: Option<String> = None;
    let mut current_body = String::new();
    let mut index = 0usize;

    for line in text.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            if let Some(previous) = current_heading.take() {
                let body = current_body.trim().to_string();
                sections.push(Section {
                    heading: previous,
                    text: if body.is_empty() {
                        String::new()
                    } else {
                        format!("{body}\n")
                    },
                    index,
                });
                index += 1;
                current_body.clear();
            }
            current_heading = Some(heading.trim().to_string());
        } else if current_heading.is_some() {
            current_body.push_str(line);
            current_body.push('\n');
        } else {
            intro.push_str(line);
            intro.push('\n');
        }
    }

    if let Some(heading) = current_heading {
        let body = current_body.trim().to_string();
        sections.push(Section {
            heading,
            text: if body.is_empty() {
                String::new()
            } else {
                format!("{body}\n")
            },
            index,
        });
    }

    (intro.trim().to_string(), sections)
}

fn section_score(heading: &str) -> u32 {
    let h = heading.to_ascii_lowercase();
    if [
        "hard",
        "强制",
        "约束",
        "guardrail",
        "护栏",
        "安全",
        "输出",
        "职责",
        "responsibil",
        "tool",
        "工具",
    ]
    .iter()
    .any(|needle| h.contains(needle))
    {
        return 100;
    }
    if [
        "编排原则",
        "协作",
        "workflow",
        "工作流",
        "验证",
        "验收",
        "memory",
        "记忆",
    ]
    .iter()
    .any(|needle| h.contains(needle))
    {
        return 80;
    }
    if ["示例", "example", "背景", "参考", "标准", "principle"]
        .iter()
        .any(|needle| h.contains(needle))
    {
        return 20;
    }
    50
}

/// Budget a system identity prompt without cutting through a section.
///
/// Sections with the same score retain their original order. If a single
/// high-value section is larger than the whole budget, only that emergency
/// case uses a UTF-8-safe truncation and metadata makes the loss explicit.
pub fn budget_identity(text: &str, budget: &ContextSlotBudget) -> Option<BudgetedPrompt> {
    if budget.compress == CompressMode::Omit {
        return None;
    }

    let original_chars = char_len(text);
    let max_chars = budget.max_chars as usize;
    if original_chars <= max_chars {
        return Some(BudgetedPrompt {
            text: text.to_string(),
            meta: json!({
                "original_chars": original_chars,
                "final_chars": original_chars,
                "compression": "none",
                "truncated": false,
                "omitted_sections": [],
            }),
        });
    }

    let (intro, sections) = split_sections(text);
    if sections.is_empty() {
        let out = truncate_utf8(text, max_chars);
        return Some(BudgetedPrompt {
            text: out.clone(),
            meta: json!({
                "original_chars": original_chars,
                "final_chars": char_len(&out),
                "compression": "utf8_truncate_emergency",
                "truncated": true,
                "omitted_sections": [],
            }),
        });
    }

    let mut selected = Vec::new();
    let mut used = char_len(&intro);
    if !intro.is_empty() {
        used += 2;
    }

    let mut ranked = sections.clone();
    ranked.sort_by(|a, b| {
        section_score(&b.heading)
            .cmp(&section_score(&a.heading))
            .then_with(|| a.index.cmp(&b.index))
    });

    for section in ranked {
        let rendered_len = section.heading.chars().count() + 3 + char_len(&section.text);
        let separator = if selected.is_empty() && intro.is_empty() {
            0
        } else {
            2
        };
        if used + separator + rendered_len <= max_chars {
            used += separator + rendered_len;
            selected.push(section.index);
        }
    }

    selected.sort_unstable();
    let selected_set: std::collections::HashSet<usize> = selected.iter().copied().collect();
    let omitted_sections: Vec<String> = sections
        .iter()
        .filter(|s| !selected_set.contains(&s.index))
        .map(|s| s.heading.clone())
        .collect();

    let mut parts = Vec::new();
    if !intro.is_empty() {
        parts.push(intro);
    }
    for section in sections {
        if selected_set.contains(&section.index) {
            parts.push(if section.text.is_empty() {
                format!("## {}", section.heading)
            } else {
                format!("## {}\n{}", section.heading, section.text.trim_end())
            });
        }
    }
    let out = parts.join("\n\n");

    // A single mandatory section can exceed the budget. Keep the heading and
    // mark this exceptional case rather than silently pretending it was safe.
    let (out, compression) = if char_len(&out) > max_chars {
        (
            truncate_utf8(&out, max_chars),
            "section_select_plus_utf8_truncate_emergency",
        )
    } else {
        (out, "section_select")
    };
    Some(BudgetedPrompt {
        text: out.clone(),
        meta: json!({
            "original_chars": original_chars,
            "final_chars": char_len(&out),
            "compression": compression,
            "truncated": char_len(&out) < original_chars,
            "omitted_sections": omitted_sections,
        }),
    })
}

/// Budget an ordinary slot. The slot metadata is intentionally uniform with
/// identity metadata so the monitor can inspect every rendered slot.
pub fn budget_slot(
    text: &str,
    budget: &ContextSlotBudget,
    compression: &str,
) -> Option<BudgetedPrompt> {
    if budget.compress == CompressMode::Omit {
        return None;
    }
    let original_chars = char_len(text);
    let out = truncate_utf8(text, budget.max_chars as usize);
    Some(BudgetedPrompt {
        text: out.clone(),
        meta: json!({
            "original_chars": original_chars,
            "final_chars": char_len(&out),
            "compression": if char_len(&out) < original_chars {
                compression
            } else {
                "none"
            },
            "truncated": char_len(&out) < original_chars,
            "omitted_sections": [],
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::{budget_identity, budget_slot};
    use qubit_protocol::{CompressMode, ContextSlotBudget};

    fn budget(max_chars: u32) -> ContextSlotBudget {
        ContextSlotBudget {
            max_chars,
            compress: CompressMode::Truncate,
            priority: 100,
        }
    }

    #[test]
    fn identity_drops_complete_low_priority_sections() {
        let input = "你是研究代理。\n\n## 硬约束\n必须先验证证据。\n\n## 示例\n这是一个很长的示例，不应被截断。这是一个很长的示例，不应被截断。这是一个很长的示例，不应被截断。\n\n## 输出\n必须输出结论和风险。";
        let rendered = budget_identity(input, &budget(70)).unwrap();
        assert!(rendered.text.contains("## 硬约束"));
        assert!(rendered.text.contains("## 输出"));
        assert!(!rendered.text.contains("这是一个很长的示例"));
        assert_eq!(rendered.meta["truncated"], true);
        assert!(rendered.meta["omitted_sections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "示例"));
    }

    #[test]
    fn ordinary_slot_truncation_is_utf8_safe_and_observable() {
        let rendered = budget_slot("中文内容很长", &budget(2), "utf8_truncate").unwrap();
        assert_eq!(rendered.text, "中…");
        assert_eq!(rendered.meta["truncated"], true);
        assert_eq!(rendered.meta["compression"], "utf8_truncate");
    }
}
