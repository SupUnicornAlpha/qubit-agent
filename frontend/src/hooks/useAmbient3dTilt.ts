import { useEffect } from "react";
import { useAppStore } from "../store";
import { A3D_TILT_SELECTOR } from "../theme/ambient-3d-tilt-targets";

/** 悬停时在基础倾角上叠加的最大角度（度） */
const MAX_RX = 10;
const MAX_RY = 7;

/**
 * 光标悬停任意 3D 模块时写入局部 --qb-a3d-rx / --qb-a3d-ry，驱动 hover 加深倾斜。
 */
export function useAmbient3dTilt(): void {
  const uiStyle = useAppStore((s) => s.uiStyle);

  useEffect(() => {
    if (uiStyle !== "ambient-3d") return;

    let active: HTMLElement | null = null;

    const clear = () => {
      if (!active) return;
      active.classList.remove("qb-a3d-tilt--active");
      active.style.removeProperty("--qb-a3d-rx");
      active.style.removeProperty("--qb-a3d-ry");
      active = null;
    };

    const onMove = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>(A3D_TILT_SELECTOR) ?? null;
      if (!el) {
        clear();
        return;
      }
      if (active !== el) {
        clear();
        active = el;
        active.classList.add("qb-a3d-tilt--active");
      }
      const rect = el.getBoundingClientRect();
      const w = Math.max(rect.width, 1);
      const h = Math.max(rect.height, 1);
      const x = ((e.clientX - rect.left) / w - 0.5) * 2;
      const y = ((e.clientY - rect.top) / h - 0.5) * 2;
      el.style.setProperty("--qb-a3d-rx", `${(x * MAX_RX).toFixed(2)}deg`);
      el.style.setProperty("--qb-a3d-ry", `${(-y * MAX_RY).toFixed(2)}deg`);
    };

    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointercancel", clear, { passive: true });
    window.addEventListener("blur", clear);

    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [uiStyle]);
}
