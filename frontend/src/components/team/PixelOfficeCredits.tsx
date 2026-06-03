import type { FC } from "react";
import { useEffect } from "react";
import { useTranslation } from "../../i18n";
import { getActiveTheme } from "../../lib/pixelOffice/themes";

type Props = {
  open: boolean;
  onClose: () => void;
};

export const PixelOfficeCredits: FC<Props> = ({ open, onClose }) => {
  const { t } = useTranslation();

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
        aria-label={t("team.pixelOffice.credits.dialogAriaLabel")}
      >
        <header className="qb-pixel-office-credits-header">
          <h3>{t("team.pixelOffice.credits.title")}</h3>
          <button
            type="button"
            className="qb-pixel-office-credits-close"
            onClick={onClose}
            aria-label={t("team.pixelOffice.credits.close")}
          >
            ×
          </button>
        </header>
        <p className="qb-pixel-office-credits-intro">
          {t("team.pixelOffice.credits.intro")}
        </p>
        <ul className="qb-pixel-office-credits-list">
          {attribution.map((a) => (
            <li key={a.url}>
              <a href={a.url} target="_blank" rel="noopener noreferrer">
                {a.name}
              </a>
              <span className={`qb-pixel-office-credits-license${a.required ? " is-required" : ""}`}>
                {a.license}
                {a.required && (
                  <em title={t("team.pixelOffice.credits.requiredAttributionTitle")}>
                    {t("team.pixelOffice.credits.requiredAttribution")}
                  </em>
                )}
              </span>
            </li>
          ))}
        </ul>
        <footer className="qb-pixel-office-credits-footer">
          {t("team.pixelOffice.credits.footer")}
        </footer>
      </div>
    </div>
  );
};
