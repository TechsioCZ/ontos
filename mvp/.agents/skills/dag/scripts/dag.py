#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


FRONTIER_MODES = {"summary", "dag", "frontier"}


def default_plans_root() -> Path:
    raw = os.environ.get("CODEX_PLANS_ROOT")
    if raw:
        return Path(raw).expanduser()

    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        return Path(codex_home).expanduser() / "plans"

    return Path.cwd() / ".codex" / "plans"


def default_state_root() -> Path:
    raw = os.environ.get("CODEX_PLAN_GRAPHS_ROOT")
    if raw:
        return Path(raw).expanduser()

    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        return Path(codex_home).expanduser() / "plan-graphs"

    return Path.cwd() / ".codex" / "plan-graphs"


def safe_graph_id(raw: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", raw.strip())
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")
    return cleaned or "plan-graph"


def graph_snapshot_path(graph_id: str, state_root: Path) -> Path:
    return state_root / safe_graph_id(graph_id) / "snapshot.json"


def load_snapshot_by_graph_id(graph_id: str, state_root: Path) -> dict | None:
    if not graph_id.strip():
        return None

    snapshot_path = graph_snapshot_path(graph_id, state_root.expanduser())
    if not snapshot_path.exists():
        return None

    try:
        return json.loads(snapshot_path.read_text())
    except Exception:
        return None


def normalize_argv(argv: list[str]) -> list[str]:
    if not argv or argv[0].startswith("-"):
        return ["frontier", *argv]
    return argv


def parse_known_cli(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("mode", nargs="?")
    parser.add_argument("--graph-id", default=os.environ.get("GRAPH_ID", ""))
    parser.add_argument("--state-dir", type=Path, default=None)
    parser.add_argument("--plan", action="append", default=[])
    parser.add_argument("--plans-root", type=Path, default=None)
    parser.add_argument("--glob", action="append", default=[])
    parser.add_argument("--depends", action="append", default=[])
    return parser.parse_known_args(argv)[0]


def normalize_path(path: Path) -> str:
    try:
        return str(path.expanduser().resolve())
    except FileNotFoundError:
        return str(path.expanduser().absolute())


def resolve_selected_plan_paths(args: argparse.Namespace) -> list[str]:
    plans_root = (args.plans_root or default_plans_root()).expanduser()
    selected: set[str] = set()

    for plan_arg in args.plan:
        selected.add(normalize_path(Path(plan_arg)))

    for pattern in args.glob:
        for path in plans_root.glob(pattern):
            if path.is_file():
                selected.add(normalize_path(path))

    return sorted(selected)


def normalize_snapshot_paths(paths: object) -> list[str]:
    if not isinstance(paths, list):
        return []
    return sorted(normalize_path(Path(path)) for path in paths if isinstance(path, str) and path.strip())


def normalize_snapshot_edges(edges: object) -> list[str]:
    if not isinstance(edges, list):
        return []

    depends: list[str] = []
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        source = str(edge.get("source") or "").strip()
        target = str(edge.get("target") or "").strip()
        if source and target:
            depends.append(f"{source}:{target}")
    return depends


def apply_snapshot_defaults(argv: list[str]) -> list[str]:
    parsed = parse_known_cli(argv)
    mode = parsed.mode or "frontier"
    if mode not in FRONTIER_MODES or not parsed.graph_id:
        return argv

    snapshot = load_snapshot_by_graph_id(
        parsed.graph_id,
        parsed.state_dir if parsed.state_dir is not None else default_state_root(),
    )
    if snapshot is None:
        return argv

    if parsed.depends:
        return argv

    selected_plan_paths = resolve_selected_plan_paths(parsed)
    snapshot_plan_paths = normalize_snapshot_paths(snapshot.get("selected_plan_paths"))
    if selected_plan_paths and snapshot_plan_paths and selected_plan_paths != snapshot_plan_paths:
        print(
            f"dag.py: explicit selection does not match saved snapshot for --graph-id {parsed.graph_id}; "
            "saved dependency edges were not applied.",
            file=sys.stderr,
        )
        return argv

    snapshot_depends = normalize_snapshot_edges(snapshot.get("edges"))
    if not snapshot_depends:
        return argv

    rewritten = list(argv)
    for dependency in snapshot_depends:
        rewritten.extend(["--depends", dependency])
    return rewritten


def main() -> int:
    script_path = Path(__file__).resolve()
    plan_graph = script_path.parents[2] / "plan-graph" / "scripts" / "plan_graph.py"
    args = apply_snapshot_defaults(normalize_argv(sys.argv[1:]))
    os.execv(sys.executable, [sys.executable, str(plan_graph), *args])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
