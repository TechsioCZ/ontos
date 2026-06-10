#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path
import tomllib


DEFAULT_MAX_THREADS = 6
DEFAULT_MAX_DEPTH = 1


def _read_int(value):
    return value if isinstance(value, int) else None


def _read_limits(config_path: Path) -> tuple[int, int]:
    with config_path.open("rb") as handle:
        data = tomllib.load(handle)

    agents = data.get("agents")
    max_threads = _read_int(agents.get("max_threads")) if isinstance(agents, dict) else None
    max_depth = _read_int(agents.get("max_depth")) if isinstance(agents, dict) else None

    if max_threads is None:
        max_threads = _read_int(data.get("agent_max_threads"))
    if max_depth is None:
        max_depth = _read_int(data.get("agent_max_depth"))

    threads = max_threads if max_threads is not None else DEFAULT_MAX_THREADS
    depth = max_depth if max_depth is not None else DEFAULT_MAX_DEPTH
    return threads, depth


def main() -> int:
    explicit = sys.argv[1] if len(sys.argv) > 1 else ""
    config_path: str | None = None

    if explicit:
        config_path = explicit
    elif codex_home := os.environ.get("CODEX_HOME"):
        candidate = Path(codex_home).expanduser() / "config.toml"
        if candidate.exists():
            config_path = str(candidate)
    elif home := os.environ.get("HOME"):
        candidate = Path(home).expanduser() / ".codex" / "config.toml"
        if candidate.exists():
            config_path = str(candidate)

    if config_path:
        resolved = Path(config_path).expanduser()
        if not resolved.exists():
            print(f"Config file not found: {resolved}", file=sys.stderr)
            return 1

        max_threads, max_depth = _read_limits(resolved)
        source = str(resolved)
    else:
        max_threads = DEFAULT_MAX_THREADS
        max_depth = DEFAULT_MAX_DEPTH
        source = "defaults"

    print(f"max_threads={max_threads}")
    print(f"max_depth={max_depth}")
    print(f"source={source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
