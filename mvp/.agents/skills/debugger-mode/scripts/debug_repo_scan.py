#!/usr/bin/env python3
"""Scan a codebase for debugger-related patterns.

Use this tool to quickly locate:
- `#region` markers used for temporary debug sections
- `fetch(...)` calls that appear to target ingest routes
- arbitrary string or regex patterns across the repository
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Iterable, List, Tuple

DEFAULT_EXCLUDES = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    "coverage",
    "target",
    ".cursor",
}
MAX_FILE_BYTES = 1_000_000


def iter_candidate_files(root: Path, excludes: set[str]) -> Iterable[Path]:
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in excludes for part in path.parts):
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
            # Keep this scanner language-agnostic by treating any non-binary file as text.
            with path.open("rb") as raw:
                if b"\x00" in raw.read(4096):
                    continue
        except OSError:
            continue
        yield path


def safe_read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def print_matches(title: str, matches: List[Tuple[Path, int, str]], root: Path) -> int:
    print(f"## {title}")
    if not matches:
        print("(no matches)")
        print()
        return 0

    for path, line_no, snippet in matches:
        rel = path.relative_to(root)
        clean = " ".join(snippet.strip().split())
        if len(clean) > 220:
            clean = f"{clean[:217]}..."
        print(f"{rel}:{line_no}: {clean}")
    print()
    print(f"Total: {len(matches)}")
    print()
    return len(matches)


def search_regions(root: Path, files: Iterable[Path]) -> List[Tuple[Path, int, str]]:
    pattern = re.compile(r"(#region|//\s*#region|/\*\s*#region)", re.IGNORECASE)
    results: List[Tuple[Path, int, str]] = []
    for path in files:
        text = safe_read(path)
        if not text:
            continue
        for idx, line in enumerate(text.splitlines(), 1):
            if pattern.search(line):
                results.append((path, idx, line))
    return results


def search_ingest_fetch(root: Path, files: Iterable[Path]) -> List[Tuple[Path, int, str]]:
    results: List[Tuple[Path, int, str]] = []
    seen = set()

    for path in files:
        text = safe_read(path)
        if not text:
            continue
        lines = text.splitlines()
        lowered = [line.lower() for line in lines]

        for idx, line in enumerate(lowered):
            if "fetch(" not in line:
                continue
            window = "\n".join(lowered[idx : idx + 10])
            if "ingest" not in window:
                continue
            key = (path, idx + 1)
            if key in seen:
                continue
            seen.add(key)
            results.append((path, idx + 1, lines[idx]))

    return results


def search_pattern(
    root: Path,
    files: Iterable[Path],
    pattern: str,
    regex: bool,
    ignore_case: bool,
) -> List[Tuple[Path, int, str]]:
    flags = re.IGNORECASE if ignore_case else 0
    matcher = re.compile(pattern if regex else re.escape(pattern), flags)

    results: List[Tuple[Path, int, str]] = []
    for path in files:
        text = safe_read(path)
        if not text:
            continue
        for idx, line in enumerate(text.splitlines(), 1):
            if matcher.search(line):
                results.append((path, idx, line))
    return results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search debug patterns in a codebase")
    parser.add_argument("--root", default=".", help="Project root directory")
    parser.add_argument(
        "--exclude",
        default=",".join(sorted(DEFAULT_EXCLUDES)),
        help="Comma-separated directories to ignore",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("regions", help="Find #region markers")
    subparsers.add_parser("ingest-fetch", help="Find fetch calls that appear to target ingest")
    subparsers.add_parser("all", help="Run both regions and ingest-fetch scans")

    search_parser = subparsers.add_parser("search", help="Search for a literal or regex pattern")
    search_parser.add_argument("--pattern", required=True, help="Pattern to find")
    search_parser.add_argument("--regex", action="store_true", help="Treat pattern as regex")
    search_parser.add_argument("--ignore-case", action="store_true", help="Case-insensitive search")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    if not root.exists() or not root.is_dir():
        print(f"Root does not exist or is not a directory: {root}")
        return 2

    excludes = {item.strip() for item in args.exclude.split(",") if item.strip()}
    files = list(iter_candidate_files(root, excludes))

    if args.command == "regions":
        matches = search_regions(root, files)
        print_matches("#region markers", matches, root)
        return 0

    if args.command == "ingest-fetch":
        matches = search_ingest_fetch(root, files)
        print_matches("fetch(...) near ingest", matches, root)
        return 0

    if args.command == "search":
        matches = search_pattern(
            root,
            files,
            pattern=args.pattern,
            regex=args.regex,
            ignore_case=args.ignore_case,
        )
        label = f"pattern: {args.pattern}"
        print_matches(label, matches, root)
        return 0

    if args.command == "all":
        region_matches = search_regions(root, files)
        ingest_matches = search_ingest_fetch(root, files)
        print_matches("#region markers", region_matches, root)
        print_matches("fetch(...) near ingest", ingest_matches, root)
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
