#!/usr/bin/env python3
"""
将「原版」Randa Liquid Glass .icns 写入本仓库（不做调色），避免 sips 压图时把透明底合成成黑底。

依赖：macOS 自带的 iconutil、sips；Python 3 + Pillow（与 tint 脚本相同环境）。

用法（在仓库根目录）:
  /opt/miniconda3/bin/python3 frontend/scripts/apply_randa_original_icon.py
  # 或指定 icns 路径:
  python3 frontend/scripts/apply_randa_original_icon.py /path/to/Randa__Liquid_Glass_.icns
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

DEFAULT_ICNS = Path.home() / "Downloads" / "Randa__Liquid_Glass_.icns"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def iconutil_convert_iconset(icns: Path, out_iconset: Path) -> None:
    out_iconset.parent.mkdir(parents=True, exist_ok=True)
    if out_iconset.exists():
        shutil.rmtree(out_iconset)
    subprocess.run(
        ["iconutil", "--convert", "iconset", "-o", str(out_iconset), str(icns)],
        check=True,
    )


def iconutil_pack_icns(iconset: Path, out_icns: Path) -> None:
    out_icns.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out_icns)], check=True)


def fill_missing_iconset_pngs(iconset: Path) -> None:
    """部分 icns 解包缺 16/32 基础档，从 128 缩一张避免 iconutil 失败。"""
    p128 = iconset / "icon_128x128.png"
    if not p128.exists():
        raise FileNotFoundError(p128)
    if not (iconset / "icon_16x16.png").exists():
        subprocess.run(["sips", "-z", "16", "16", str(p128), "--out", str(iconset / "icon_16x16.png")], check=True)
    if not (iconset / "icon_32x32.png").exists():
        subprocess.run(["sips", "-z", "32", "32", str(p128), "--out", str(iconset / "icon_32x32.png")], check=True)


def rgba_png_for_web(src_png: Path, out_512: Path) -> None:
    """用 Pillow 写 PNG，保留 alpha，避免透明区域被填成黑色。"""
    im = Image.open(src_png).convert("RGBA")
    im.thumbnail((512, 512), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    x = (512 - im.width) // 2
    y = (512 - im.height) // 2
    canvas.paste(im, (x, y), im)
    out_512.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_512, format="PNG", optimize=True)


def main() -> None:
    icns = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT_ICNS
    if not icns.is_file():
        print(f"找不到 icns: {icns}", file=sys.stderr)
        sys.exit(1)

    root = repo_root()
    tauri_icons = root / "src-tauri" / "icons"
    web_icon = root / "frontend" / "public" / "icon.png"

    with tempfile.TemporaryDirectory(prefix="randa-orig-") as td:
        iconset = Path(td) / "RandaOriginal.iconset"
        packed = Path(td) / "RandaOriginal.icns"
        iconutil_convert_iconset(icns, iconset)
        fill_missing_iconset_pngs(iconset)
        iconutil_pack_icns(iconset, packed)

        master = iconset / "icon_512x512@2x.png"
        if not master.exists():
            master = iconset / "icon_512x512.png"
        if not master.exists():
            raise FileNotFoundError("未找到 512@2x 或 512 源 PNG")

        if tauri_icons.is_dir():
            shutil.copy2(packed, tauri_icons / "icon.icns")
            print("已写入:", tauri_icons / "icon.icns")
        else:
            print("跳过 icns：不存在", tauri_icons)

        rgba_png_for_web(master, web_icon)
        print("已写入（RGBA）:", web_icon)

    print("完成。如需同步 Windows 等衍生资源，可在仓库根执行：")
    print("  bunx @tauri-apps/cli icon frontend/public/icon.png --output src-tauri/icons")
    print("然后请再手动用原版 icns 覆盖 src-tauri/icons/icon.icns（避免 tauri icon 覆盖 macOS 高质量 icns）。")


if __name__ == "__main__":
    main()
