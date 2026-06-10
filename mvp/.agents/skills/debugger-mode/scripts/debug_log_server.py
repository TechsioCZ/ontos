#!/usr/bin/env python3
"""Run a local debug ingest HTTP server and manage session log files.

The server accepts POST requests at /ingest/<route-token> and appends each
valid JSON payload as one NDJSON line to the configured session log file.
By default, logs and runtime metadata are written under <project-root>/.cursor.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Tuple

REQUIRED_FIELDS = (
    "sessionId",
    "runId",
    "hypothesisId",
    "location",
    "message",
    "data",
    "timestamp",
)
PID_FILENAME = ".debug-log-server.pid"
STDOUT_FILENAME = ".debug-log-server.out"
HEADER_SESSION = "X-Debug-Session-Id"
STATE_DIRNAME = ".cursor"


class IngestServer(ThreadingHTTPServer):
    """HTTP server that stores configuration for request handlers."""

    def __init__(self, address: Tuple[str, int], handler_cls, config: Dict[str, str]):
        super().__init__(address, handler_cls)
        self.config = config


class IngestHandler(BaseHTTPRequestHandler):
    """Validate inbound payloads and append them to NDJSON logs."""

    def do_POST(self) -> None:  # noqa: N802 (http verb naming)
        config = self.server.config
        if self.path != config["route_path"]:
            self._json_response(404, {"error": "route_not_found"})
            return

        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            self._json_response(415, {"error": "unsupported_media_type"})
            return

        expected_session = config.get("session_id")
        header_session = self.headers.get(HEADER_SESSION)
        if expected_session and header_session != expected_session:
            self._json_response(
                401,
                {
                    "error": "invalid_session_header",
                    "expected": expected_session,
                    "header": HEADER_SESSION,
                },
            )
            return

        length_raw = self.headers.get("Content-Length")
        if not length_raw:
            self._json_response(411, {"error": "missing_content_length"})
            return

        try:
            content_length = int(length_raw)
        except ValueError:
            self._json_response(400, {"error": "invalid_content_length"})
            return

        try:
            body_raw = self.rfile.read(content_length)
            payload = json.loads(body_raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json_response(400, {"error": "invalid_json"})
            return

        if not isinstance(payload, dict):
            self._json_response(400, {"error": "payload_must_be_object"})
            return

        if expected_session and payload.get("sessionId") != expected_session:
            self._json_response(
                400,
                {
                    "error": "session_mismatch",
                    "expected": expected_session,
                    "body_session_id": payload.get("sessionId"),
                },
            )
            return

        missing = [field for field in REQUIRED_FIELDS if field not in payload]
        if missing:
            self._json_response(400, {"error": "missing_fields", "fields": missing})
            return

        payload["receivedAt"] = int(time.time() * 1000)
        log_path = Path(config["log_file"])
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True))
            handle.write("\n")

        self._json_response(202, {"status": "ok", "log_file": str(log_path)})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            config = self.server.config
            self._json_response(
                200,
                {
                    "status": "ok",
                    "route": config["route_path"],
                    "log_file": config["log_file"],
                },
            )
            return
        self._json_response(404, {"error": "not_found"})

    def _json_response(self, status: int, body: Dict[str, object]) -> None:
        payload = json.dumps(body, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def build_paths(project_root: Path, session_id: str | None, explicit_log_file: str | None):
    suffix = session_id.strip() if session_id else "session"
    suffix = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in suffix)
    if not suffix:
        suffix = "session"
    state_dir = project_root / STATE_DIRNAME
    state_dir.mkdir(parents=True, exist_ok=True)

    if explicit_log_file:
        log_file = Path(explicit_log_file)
        if not log_file.is_absolute():
            log_file = project_root / log_file
    else:
        log_file = state_dir / f"debug-{suffix}.log"

    pid_file = state_dir / f"{PID_FILENAME.rsplit('.', 1)[0]}-{suffix}.pid"
    stdout_file = state_dir / f"{STDOUT_FILENAME.rsplit('.', 1)[0]}-{suffix}.out"
    return log_file.resolve(), pid_file.resolve(), stdout_file.resolve()


def route_path_from_token(token: str) -> str:
    cleaned = token.strip().strip("/")
    if not cleaned:
        raise ValueError("route token cannot be empty")
    return f"/ingest/{cleaned}"


def process_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_pid(pid_file: Path) -> int | None:
    if not pid_file.exists():
        return None
    try:
        value = pid_file.read_text(encoding="utf-8").strip()
        return int(value)
    except (ValueError, OSError):
        return None


def write_pid(pid_file: Path, pid: int) -> None:
    pid_file.write_text(f"{pid}\n", encoding="utf-8")


def remove_pid(pid_file: Path) -> None:
    if pid_file.exists():
        pid_file.unlink()


def daemon_start(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    project_root.mkdir(parents=True, exist_ok=True)

    log_file, pid_file, stdout_file = build_paths(project_root, args.session_id, args.log_file)
    existing_pid = read_pid(pid_file)
    if existing_pid and process_running(existing_pid):
        print(f"Server already running with pid {existing_pid} (pid file: {pid_file})")
        return 1
    if existing_pid:
        remove_pid(pid_file)

    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "start",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--route-token",
        args.route_token,
        "--project-root",
        str(project_root),
    ]

    if args.session_id:
        cmd.extend(["--session-id", args.session_id])
    if args.log_file:
        cmd.extend(["--log-file", args.log_file])

    with stdout_file.open("a", encoding="utf-8") as out:
        proc = subprocess.Popen(  # noqa: S603
            cmd,
            cwd=project_root,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=out,
            start_new_session=True,
        )

    write_pid(pid_file, proc.pid)
    time.sleep(0.25)
    if not process_running(proc.pid):
        print("Failed to start server. Check output log:")
        print(stdout_file)
        remove_pid(pid_file)
        return 1

    print(f"Started debug log server (pid={proc.pid})")
    print(f"Route: http://{args.host}:{args.port}{route_path_from_token(args.route_token)}")
    print(f"Session log: {log_file}")
    print(f"PID file: {pid_file}")
    print(f"Process output: {stdout_file}")
    return 0


def run_foreground(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    project_root.mkdir(parents=True, exist_ok=True)

    log_file, pid_file, _ = build_paths(project_root, args.session_id, args.log_file)
    route_path = route_path_from_token(args.route_token)
    config = {
        "route_path": route_path,
        "log_file": str(log_file),
        "session_id": args.session_id or "",
    }

    server = IngestServer((args.host, args.port), IngestHandler, config)
    write_pid(pid_file, os.getpid())

    def shutdown_handler(signum, frame) -> None:  # noqa: ARG001
        # shutdown() must run outside the serve_forever thread to avoid deadlock.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    print(f"Listening on http://{args.host}:{args.port}{route_path}")
    print(f"Writing NDJSON logs to: {log_file}")
    if args.session_id:
        print(f"Expecting {HEADER_SESSION}: {args.session_id}")

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        remove_pid(pid_file)

    return 0


def stop_server(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    _, pid_file, _ = build_paths(project_root, args.session_id, args.log_file)
    pid = read_pid(pid_file)

    if not pid:
        print(f"No pid file found at {pid_file}")
        return 1

    if not process_running(pid):
        print(f"Process {pid} is not running; removing stale pid file")
        remove_pid(pid_file)
        return 0

    os.kill(pid, signal.SIGTERM)

    deadline = time.time() + 5.0
    while time.time() < deadline:
        if not process_running(pid):
            remove_pid(pid_file)
            print(f"Stopped debug log server pid {pid}")
            return 0
        time.sleep(0.1)

    print(f"Timed out waiting for pid {pid} to exit, sending SIGKILL")
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        remove_pid(pid_file)
        print(f"Process {pid} already exited")
        return 0

    deadline = time.time() + 2.0
    while time.time() < deadline:
        if not process_running(pid):
            remove_pid(pid_file)
            print(f"Force-stopped debug log server pid {pid}")
            return 0
        time.sleep(0.1)

    print(f"Failed to stop pid {pid}")
    return 1


def status_server(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    log_file, pid_file, _ = build_paths(project_root, args.session_id, args.log_file)
    pid = read_pid(pid_file)

    if pid and process_running(pid):
        print(f"running pid={pid}")
        print(f"pid_file={pid_file}")
        print(f"log_file={log_file}")
        return 0

    print("not running")
    print(f"pid_file={pid_file}")
    print(f"log_file={log_file}")
    return 1


def reset_log(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    log_file, _, _ = build_paths(project_root, args.session_id, args.log_file)

    if log_file.exists():
        log_file.unlink()
        print(f"Deleted log file: {log_file}")
    else:
        print(f"No log file to delete: {log_file}")

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage local debug ingest log server")
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_common_arguments(command_parser: argparse.ArgumentParser, include_route: bool = True):
        command_parser.add_argument("--project-root", default=".", help="Project root for log and pid files")
        command_parser.add_argument("--session-id", help="Expected debug session id")
        command_parser.add_argument(
            "--log-file",
            help=(
                "Absolute or project-root relative log file path "
                "(default: .cursor/debug-<session>.log)"
            ),
        )
        if include_route:
            command_parser.add_argument("--host", default="127.0.0.1")
            command_parser.add_argument("--port", type=int, default=7276)
            command_parser.add_argument("--route-token", required=True)

    start_parser = subparsers.add_parser("start", help="Start ingest server")
    add_common_arguments(start_parser, include_route=True)
    start_parser.add_argument(
        "--daemon",
        action="store_true",
        help="Start in the background and return immediately",
    )

    stop_parser = subparsers.add_parser("stop", help="Stop ingest server")
    add_common_arguments(stop_parser, include_route=False)

    status_parser = subparsers.add_parser("status", help="Show server status")
    add_common_arguments(status_parser, include_route=False)

    reset_parser = subparsers.add_parser("reset-log", help="Delete current session log file")
    add_common_arguments(reset_parser, include_route=False)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "start":
        if args.daemon:
            return daemon_start(args)
        return run_foreground(args)
    if args.command == "stop":
        return stop_server(args)
    if args.command == "status":
        return status_server(args)
    if args.command == "reset-log":
        return reset_log(args)

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
