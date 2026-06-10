#!/usr/bin/env python3
"""Remove temporary debug instrumentation blocks from source files.

Instrumentation blocks must be wrapped in markers:
  DEBUG-SESSION:<session-id>-START
  DEBUG-SESSION:<session-id>-END

The script removes every marked block (including marker lines) recursively.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

DEFAULT_EXTENSIONS = (
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
)
DEFAULT_EXCLUDES = (
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
)


def iter_files(root: Path, extensions: Iterable[str], excludes: Iterable[str]):
    ext_set = {ext if ext.startswith(".") else f".{ext}" for ext in extensions}
    excluded = set(excludes)

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in excluded for part in path.parts):
            continue
        if path.suffix.lower() not in ext_set:
            continue
        yield path


def remove_blocks(text: str, start_marker: str, end_marker: str):
    lines = text.splitlines(keepends=True)
    output = []
    removed = 0
    in_block = False

    for line in lines:
        if start_marker in line:
            in_block = True
            removed += 1
            continue
        if in_block:
            removed += 1
            if end_marker in line:
                in_block = False
            continue
        output.append(line)

    return "".join(output), removed


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove marker-wrapped debug instrumentation")
    parser.add_argument("--root", default=".", help="Project root to scan")
    parser.add_argument("--session-id", required=True, help="Session id used in markers")
    parser.add_argument(
        "--extensions",
        default=",".join(DEFAULT_EXTENSIONS),
        help="Comma-separated file extensions to scan",
    )
    parser.add_argument(
        "--exclude",
        default=",".join(DEFAULT_EXCLUDES),
        help="Comma-separated directories to ignore",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing files")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.exists() or not root.is_dir():
        print(f"Root does not exist or is not a directory: {root}")
        return 2

    extensions = [item.strip() for item in args.extensions.split(",") if item.strip()]
    excludes = [item.strip() for item in args.exclude.split(",") if item.strip()]

    start_marker = f"DEBUG-SESSION:{args.session_id}-START"
    end_marker = f"DEBUG-SESSION:{args.session_id}-END"

    changed_files = 0
    removed_lines = 0

    for path in iter_files(root, extensions, excludes):
        original = path.read_text(encoding="utf-8", errors="ignore")
        updated, removed = remove_blocks(original, start_marker, end_marker)
        if removed == 0:
            continue

        changed_files += 1
        removed_lines += removed

        if not args.dry_run:
            path.write_text(updated, encoding="utf-8")

        print(f"updated {path} (removed {removed} lines)")

    mode = "dry-run" if args.dry_run else "write"
    print(f"mode={mode} changed_files={changed_files} removed_lines={removed_lines}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
