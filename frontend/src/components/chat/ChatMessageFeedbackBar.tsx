/**
 * Assistant 消息 thumbs up/down 反馈条。
 */
import { useState, type FC } from "react";
import { submitChatMessageFeedback } from "../../api/backend";

export type ChatMessageFeedbackBarProps = {
  chatMessageId: string;
  disabled?: boolean;
};

export const ChatMessageFeedbackBar: FC<ChatMessageFeedbackBarProps> = ({
  chatMessageId,
  disabled,
}) => {
  const [submitted, setSubmitted] = useState<"helpful" | "not_helpful" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFeedback = async (helpful: boolean) => {
    if (disabled || busy || submitted) return;
    setBusy(true);
    setError(null);
    try {
      await submitChatMessageFeedback(chatMessageId, { helpful });
      setSubmitted(helpful ? "helpful" : "not_helpful");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qb-chat-feedback" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
      <button
        type="button"
        className="qb-btn-ghost qb-btn--compact"
        disabled={disabled || busy || submitted !== null}
        onClick={() => void onFeedback(true)}
        aria-label="有帮助"
      >
        👍
      </button>
      <button
        type="button"
        className="qb-btn-ghost qb-btn--compact"
        disabled={disabled || busy || submitted !== null}
        onClick={() => void onFeedback(false)}
        aria-label="无帮助"
      >
        👎
      </button>
      {submitted ? (
        <span style={{ fontSize: 12, color: "var(--qb-chat-meta-fg)" }}>
          {submitted === "helpful" ? "感谢反馈" : "已记录，我们会改进"}
        </span>
      ) : null}
      {error ? <span style={{ fontSize: 12, color: "#f87171" }}>{error}</span> : null}
    </div>
  );
};
