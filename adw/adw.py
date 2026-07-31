#!/usr/bin/env python3
"""Plan and implement a GitHub issue while recording resumable ADW state."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import unicodedata
from pathlib import Path

from adw_github_issues import GitHubIssueError, post_issue_comment, read_issue


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILL_NAME_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
WRITE_SPEC_COMMENT = "The `$ontos-write-spec` skill will be run for this issue."
IMPLEMENT_SPEC_COMMENT = (
    "The `$ontos-implement-spec` skill will be run for this issue."
)
IMPLEMENTATION_RESULT_COMMENT_PREFIX = "Implementation result:"


class CodexTaskError(RuntimeError):
    """Raised when a spawned Codex task cannot complete successfully."""


class GitBranchError(RuntimeError):
    """Raised when ADW cannot switch to its required Git branch."""


class GitWorktreeError(RuntimeError):
    """Raised when ADW cannot create or enter an issue worktree."""


class IssueManifestError(RuntimeError):
    """Raised when an ADW issue manifest cannot be read or updated."""


def get_git_common_directory() -> Path:
    """Return the Git directory shared by the repository and its worktrees."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise IssueManifestError(
            "Git ('git') is not installed or is not on PATH."
        ) from error
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip() or error.stdout.strip() or "Unknown Git error."
        raise IssueManifestError(
            f"Could not resolve Git's common directory: {message}"
        ) from error

    git_common_directory = Path(result.stdout.strip())
    if not git_common_directory.is_absolute():
        git_common_directory = PROJECT_ROOT / git_common_directory
    return git_common_directory.resolve()


def get_issue_manifest_path(issue_number: int) -> Path:
    """Return .git/adw/issues/<issue-number>.json for this repository."""
    if issue_number < 1:
        raise ValueError("Issue number must be a positive integer.")
    return (
        get_git_common_directory()
        / "adw"
        / "issues"
        / f"{issue_number}.json"
    )


def load_issue_manifest(issue_number: int) -> dict[str, object]:
    """Load and validate one existing issue manifest."""
    manifest_path = get_issue_manifest_path(issue_number)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise IssueManifestError(
            f"Issue manifest '{manifest_path}' does not exist."
        ) from error
    except (OSError, json.JSONDecodeError) as error:
        raise IssueManifestError(
            f"Could not read issue manifest '{manifest_path}': {error}"
        ) from error

    if not isinstance(manifest, dict):
        raise IssueManifestError(
            f"Issue manifest '{manifest_path}' must contain a JSON object."
        )
    if manifest.get("issue_number") != issue_number:
        raise IssueManifestError(
            f"Issue manifest '{manifest_path}' does not belong to issue "
            f"#{issue_number}."
        )
    return manifest


def update_issue_manifest(issue_number: int, key: str, value: object) -> None:
    """Create or update one field in .git/adw/issues/<issue-number>.json."""
    if issue_number < 1:
        raise ValueError("Issue number must be a positive integer.")
    if not key.strip():
        raise ValueError("Manifest key must not be empty.")
    if key == "issue_number" and value != issue_number:
        raise ValueError("Manifest issue_number must match the file name.")

    manifest_path = get_issue_manifest_path(issue_number)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    if manifest_path.exists():
        manifest = load_issue_manifest(issue_number)
    else:
        manifest = {"issue_number": issue_number}

    manifest[key] = value
    try:
        serialized_manifest = (
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        )
    except (TypeError, ValueError) as error:
        raise IssueManifestError(
            f"Manifest value for '{key}' is not JSON serializable."
        ) from error

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=manifest_path.parent,
            prefix=f".{manifest_path.name}.",
            delete=False,
        ) as temporary_file:
            temporary_file.write(serialized_manifest)
            temporary_path = Path(temporary_file.name)
        os.replace(temporary_path, manifest_path)
    except OSError as error:
        raise IssueManifestError(
            f"Could not update issue manifest '{manifest_path}': {error}"
        ) from error
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def switch_to_develop() -> None:
    """Switch the project to develop or stop with Git's explanation."""
    try:
        subprocess.run(
            ["git", "switch", "develop"],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise GitBranchError(
            "Git ('git') is not installed or is not on PATH."
        ) from error
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip() or error.stdout.strip() or "Unknown Git error."
        raise GitBranchError(
            "Could not switch to Git branch 'develop'; ADW stopped before any "
            "GitHub or Codex action. If uncommitted work is blocking the switch, "
            f"commit or stash it and retry. Git reported: {message}"
        ) from error


def slugify_issue_title(title: str) -> str:
    """Return a Git-safe, filesystem-safe slug derived from an issue title."""
    ascii_title = (
        unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    )
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")
    return slug[:60].rstrip("-") or "untitled"


def get_issue_branch_name(
    issue_number: int,
    issue_title: str,
    issue_type: str,
) -> str:
    """Return the branch name used for one typed GitHub issue."""
    if issue_number < 1:
        raise ValueError("Issue number must be a positive integer.")
    if issue_type not in {"feature", "bug", "task"}:
        raise ValueError("Issue type must be feature, bug, or task.")
    return (
        f"codex/{issue_type}-{issue_number}-{slugify_issue_title(issue_title)}"
    )


def create_issue_worktree(
    issue_number: int,
    issue_title: str,
    issue_type: str,
) -> Path:
    """Create an issue branch and worktree, then enter the worktree."""
    if issue_number < 1:
        raise ValueError("Issue number must be a positive integer.")
    if issue_type not in {"feature", "bug", "task"}:
        raise ValueError("Issue type must be feature, bug, or task.")

    slug = slugify_issue_title(issue_title)
    branch_name = get_issue_branch_name(issue_number, issue_title, issue_type)
    worktree_path = PROJECT_ROOT.parent / (
        f"{PROJECT_ROOT.name}-{issue_type}-{issue_number}-{slug}"
    )

    try:
        subprocess.run(
            [
                "git",
                "worktree",
                "add",
                "-b",
                branch_name,
                str(worktree_path),
                "develop",
            ],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise GitWorktreeError(
            "Git ('git') is not installed or is not on PATH."
        ) from error
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip() or error.stdout.strip() or "Unknown Git error."
        raise GitWorktreeError(
            f"Could not create worktree '{worktree_path}' on branch "
            f"'{branch_name}'; ADW stopped before commenting or starting Codex. "
            f"Git reported: {message}"
        ) from error

    try:
        os.chdir(worktree_path)
    except OSError as error:
        raise GitWorktreeError(
            f"Created worktree '{worktree_path}' but could not enter it: {error}"
        ) from error

    return worktree_path


def snapshot_plan_files(application_directory: Path) -> set[Path]:
    """Return the current Markdown plan files under app/specs/."""
    specs_directory = application_directory / "specs"
    if not specs_directory.exists():
        return set()
    return {
        plan_path.resolve()
        for plan_path in specs_directory.glob("*.md")
        if plan_path.is_file()
    }


def get_created_plan_file(
    application_directory: Path,
    plans_before: set[Path],
) -> str:
    """Return the one plan created by the completed specification task."""
    created_plans = sorted(
        snapshot_plan_files(application_directory) - plans_before
    )
    if len(created_plans) != 1:
        raise CodexTaskError(
            "$ontos-write-spec must create exactly one new plan under "
            f"'{application_directory / 'specs'}'; found {len(created_plans)}."
        )

    plan_path = created_plans[0]
    try:
        if not plan_path.read_text(encoding="utf-8").strip():
            raise CodexTaskError(f"Created plan '{plan_path}' is empty.")
        return plan_path.relative_to(application_directory.resolve()).as_posix()
    except OSError as error:
        raise CodexTaskError(
            f"Could not read created plan '{plan_path}': {error}"
        ) from error


def run_codex_skill(
    skill_name: str,
    parameter: str,
    *,
    working_directory: Path = PROJECT_ROOT,
) -> str:
    """Run a skill, stream its normal output, and return its final response."""
    normalized_skill_name = skill_name.removeprefix("$")
    if not SKILL_NAME_PATTERN.fullmatch(normalized_skill_name):
        raise ValueError(
            "Skill name must contain lowercase letters, digits, and hyphens only."
        )
    if not parameter.strip():
        raise ValueError("Skill parameter must not be empty.")

    prompt = (
        f"Use ${normalized_skill_name}. "
        "Treat the piped stdin content as the parameter for the skill."
    )

    final_response_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f"ontos-{normalized_skill_name}-",
            suffix=".txt",
            delete=False,
        ) as final_response_file:
            final_response_path = Path(final_response_file.name)

        result = subprocess.run(
            [
                "codex",
                "--ask-for-approval",
                "never",
                "exec",
                "--sandbox",
                "workspace-write",
                "--cd",
                str(working_directory),
                "--output-last-message",
                str(final_response_path),
                prompt,
            ],
            cwd=working_directory,
            input=parameter,
            check=False,
            text=True,
        )
        if result.returncode != 0:
            raise CodexTaskError(
                f"Codex task for ${normalized_skill_name} failed with exit "
                f"code {result.returncode}; see its stdout and stderr above."
            )

        try:
            final_response = final_response_path.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise CodexTaskError(
                f"Could not read the final response from "
                f"${normalized_skill_name}: {error}"
            ) from error
        if not final_response:
            raise CodexTaskError(
                f"Codex task for ${normalized_skill_name} returned no final response."
            )
        return final_response
    except FileNotFoundError as error:
        raise CodexTaskError(
            "Codex CLI ('codex') is not installed or is not on PATH."
        ) from error
    finally:
        if final_response_path is not None and final_response_path.exists():
            final_response_path.unlink()


def positive_integer(value: str) -> int:
    issue_number = int(value)
    if issue_number < 1:
        raise argparse.ArgumentTypeError("issue number must be a positive integer")
    return issue_number


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Read, plan, and implement a typed GitHub issue."
        )
    )
    parser.add_argument(
        "issue_number",
        type=positive_integer,
        help="GitHub issue number",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        switch_to_develop()
        issue = read_issue(args.issue_number)
        update_issue_manifest(args.issue_number, "title", issue["title"])
        update_issue_manifest(args.issue_number, "content", issue["content"])
        update_issue_manifest(args.issue_number, "issue_type", issue["type"])

        branch_name = get_issue_branch_name(
            args.issue_number,
            issue["title"],
            issue["type"],
        )
        worktree_path = create_issue_worktree(
            args.issue_number,
            issue["title"],
            issue["type"],
        )
        update_issue_manifest(args.issue_number, "branch_name", branch_name)
        update_issue_manifest(
            args.issue_number,
            "worktree_path",
            str(worktree_path),
        )

        application_directory = worktree_path / "app"
        plans_before = snapshot_plan_files(application_directory)
        post_issue_comment(args.issue_number, WRITE_SPEC_COMMENT)
        planning_issue = {
            "issue_number": args.issue_number,
            **issue,
            "type": "chore" if issue["type"] == "task" else issue["type"],
        }
        run_codex_skill(
            "ontos-write-spec",
            json.dumps(
                planning_issue,
                ensure_ascii=False,
                indent=2,
            ),
            working_directory=application_directory,
        )
        plan_file = get_created_plan_file(application_directory, plans_before)
        update_issue_manifest(args.issue_number, "plan_file", plan_file)

        manifest = load_issue_manifest(args.issue_number)
        manifest_worktree_path = manifest.get("worktree_path")
        manifest_plan_file = manifest.get("plan_file")
        if not isinstance(manifest_worktree_path, str):
            raise IssueManifestError(
                f"Issue manifest for #{args.issue_number} has no worktree_path."
            )
        if not isinstance(manifest_plan_file, str):
            raise IssueManifestError(
                f"Issue manifest for #{args.issue_number} has no plan_file."
            )

        post_issue_comment(args.issue_number, IMPLEMENT_SPEC_COMMENT)
        implementation_result = run_codex_skill(
            "ontos-implement-spec",
            manifest_plan_file,
            working_directory=Path(manifest_worktree_path) / "app",
        )
        post_issue_comment(
            args.issue_number,
            f"{IMPLEMENTATION_RESULT_COMMENT_PREFIX}\n\n{implementation_result}",
        )
    except (
        CodexTaskError,
        GitBranchError,
        GitHubIssueError,
        GitWorktreeError,
        IssueManifestError,
        ValueError,
    ) as error:
        raise SystemExit(str(error)) from error

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
