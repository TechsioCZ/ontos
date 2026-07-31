"""Read GitHub issues for this project."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Literal, TypedDict


PROJECT_ROOT = Path(__file__).resolve().parent.parent


IssueType = Literal["feature", "bug", "task"]


class GitHubIssue(TypedDict):
    title: str
    content: str
    state: Literal["open"]
    type: IssueType


class GitHubIssueError(RuntimeError):
    """Raised when an issue cannot be read from GitHub."""


def read_issue(issue_number: int) -> GitHubIssue:
    """Return an open, typed issue from the current GitHub project."""
    if issue_number < 1:
        raise ValueError("Issue number must be a positive integer.")

    try:
        result = subprocess.run(
            [
                "gh",
                "api",
                f"repos/{{owner}}/{{repo}}/issues/{issue_number}",
            ],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise GitHubIssueError(
            "GitHub CLI ('gh') is not installed or is not on PATH."
        ) from error
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip() or "Unknown GitHub CLI error."
        raise GitHubIssueError(
            f"Could not read GitHub issue #{issue_number}: {message}"
        ) from error

    try:
        issue = json.loads(result.stdout)
        raw_issue_type = issue.get("type")
        if not isinstance(raw_issue_type, dict) or not raw_issue_type.get("name"):
            raise GitHubIssueError(
                f"GitHub issue #{issue_number} must have a type set "
                "(Feature, Bug, or Task)."
            )

        issue_type = str(raw_issue_type["name"]).strip().lower()
        if issue_type not in {"feature", "bug", "task"}:
            raise GitHubIssueError(
                f"GitHub issue #{issue_number} has unsupported type "
                f"'{raw_issue_type['name']}'; expected Feature, Bug, or Task."
            )

        state = str(issue["state"]).lower()
        if state != "open":
            raise GitHubIssueError(
                f"GitHub issue #{issue_number} must be open; "
                f"current state is {state}."
            )

        return {
            "title": issue["title"],
            "content": issue["body"] or "",
            "state": "open",
            "type": issue_type,
        }
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise GitHubIssueError(
            f"GitHub returned an unexpected response for issue #{issue_number}."
        ) from error


def post_issue_comment(issue_number: int, comment: str) -> str:
    """Post a comment to an open GitHub issue and return the comment URL."""
    if issue_number < 1:
        raise ValueError("Issue number must be a positive integer.")
    if not comment.strip():
        raise ValueError("Comment must not be empty.")

    # Reuse the issue reader so comments can only be posted to open issues.
    read_issue(issue_number)

    try:
        result = subprocess.run(
            [
                "gh",
                "issue",
                "comment",
                str(issue_number),
                "--body",
                comment,
            ],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise GitHubIssueError(
            "GitHub CLI ('gh') is not installed or is not on PATH."
        ) from error
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip() or "Unknown GitHub CLI error."
        raise GitHubIssueError(
            f"Could not comment on GitHub issue #{issue_number}: {message}"
        ) from error

    return result.stdout.strip()
