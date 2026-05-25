import type { FC } from "react";
import { useEffect } from "react";
import { getActiveTheme } from "../../lib/pixelOffice/themes";

type Props = {
  open: boolean;
  onClose: () => void;
};

export const PixelOfficeCredits: FC<Props> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;
  const attribution = getActiveTheme().atlas.attribution;

  return (
    <div className="qb-pixel-office-credits-backdrop" onClick={onClose} role="presentation">
      <div
        className="qb-pixel-office-credits"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="像素办公室美术与字体署名"
      >
        <header className="qb-pixel-office-credits-header">
          <h3>美术与字体 Credits</h3>
          <button
            type="button"
            className="qb-pixel-office-credits-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <p className="qb-pixel-office-credits-intro">
          像素办公室使用了以下开源 / CC 协议资产。点击名称跳转源链接。
        </p>
        <ul className="qb-pixel-office-credits-list">
          {attribution.map((a) => (
            <li key={a.url}>
              <a href={a.url} target="_blank" rel="noopener noreferrer">
                {a.name}
              </a>
              <span className={`qb-pixel-office-credits-license${a.required ? " is-required" : ""}`}>
                {a.license}
                {a.required && <em title="本协议要求显著署名">必须署名</em>}
              </span>
            </li>
          ))}
        </ul>
        <footer className="qb-pixel-office-credits-footer">
          猫咪精灵为本项目原创（程序化 sprite，非外部资产）。
        </footer>
      </div>
    </div>
  );
};
