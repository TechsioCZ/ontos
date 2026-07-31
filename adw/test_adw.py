from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import call
from unittest.mock import patch

import adw


class IssueManifestTests(unittest.TestCase):
    def test_update_creates_and_incrementally_updates_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            git_directory = Path(temporary_directory) / ".git"
            with patch.object(
                adw,
                "get_git_common_directory",
                return_value=git_directory,
            ):
                adw.update_issue_manifest(71, "title", "Add JSON export")
                adw.update_issue_manifest(
                    71,
                    "content",
                    "Export records as JSON.",
                )
                adw.update_issue_manifest(71, "issue_type", "feature")
                adw.update_issue_manifest(
                    71,
                    "worktree_path",
                    "/tmp/ontos-feature-71-add-json-export",
                )

                manifest_path = git_directory / "adw" / "issues" / "71.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(
            manifest,
            {
                "issue_number": 71,
                "title": "Add JSON export",
                "content": "Export records as JSON.",
                "issue_type": "feature",
                "worktree_path": "/tmp/ontos-feature-71-add-json-export",
            },
        )

    def test_load_rejects_manifest_for_another_issue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            git_directory = Path(temporary_directory) / ".git"
            manifest_path = git_directory / "adw" / "issues" / "71.json"
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text(
                json.dumps({"issue_number": 12}),
                encoding="utf-8",
            )

            with patch.object(
                adw,
                "get_git_common_directory",
                return_value=git_directory,
            ):
                with self.assertRaisesRegex(
                    adw.IssueManifestError,
                    "does not belong to issue #71",
                ):
                    adw.load_issue_manifest(71)


class PlanCaptureTests(unittest.TestCase):
    def test_returns_new_plan_relative_to_application_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            application_directory = Path(temporary_directory) / "app"
            specs_directory = application_directory / "specs"
            specs_directory.mkdir(parents=True)
            existing_plan = specs_directory / "feature-existing.md"
            existing_plan.write_text("existing\n", encoding="utf-8")
            plans_before = adw.snapshot_plan_files(application_directory)

            created_plan = specs_directory / "feature-71-add-json-export.md"
            created_plan.write_text("---\nstatus: planned\n---\n", encoding="utf-8")

            plan_file = adw.get_created_plan_file(
                application_directory,
                plans_before,
            )

        self.assertEqual(plan_file, "specs/feature-71-add-json-export.md")

    def test_rejects_multiple_new_plans(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            application_directory = Path(temporary_directory) / "app"
            specs_directory = application_directory / "specs"
            specs_directory.mkdir(parents=True)
            (specs_directory / "feature-one.md").write_text(
                "one\n",
                encoding="utf-8",
            )
            (specs_directory / "feature-two.md").write_text(
                "two\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                adw.CodexTaskError,
                "exactly one new plan",
            ):
                adw.get_created_plan_file(application_directory, set())


class CodexSkillOutputTests(unittest.TestCase):
    def test_inherits_output_and_returns_separately_captured_final_response(
        self,
    ) -> None:
        final_response_path: Path | None = None

        def run(command: list[str], **options: object) -> subprocess.CompletedProcess:
            nonlocal final_response_path
            self.assertNotIn("capture_output", options)
            self.assertNotIn("stdout", options)
            self.assertNotIn("stderr", options)
            output_option_index = command.index("--output-last-message")
            final_response_path = Path(command[output_option_index + 1])
            final_response_path.write_text(
                "Implementation completed.\n",
                encoding="utf-8",
            )
            return subprocess.CompletedProcess(command, 0)

        with (
            tempfile.TemporaryDirectory() as temporary_directory,
            patch.object(adw.subprocess, "run", side_effect=run),
        ):
            result = adw.run_codex_skill(
                "ontos-implement-spec",
                "specs/feature-example.md",
                working_directory=Path(temporary_directory),
            )

        self.assertEqual(result, "Implementation completed.")
        self.assertIsNotNone(final_response_path)
        assert final_response_path is not None
        self.assertFalse(final_response_path.exists())


class MainWorkflowTests(unittest.TestCase):
    def test_records_plan_and_passes_it_to_implementation_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            worktree_path = Path(temporary_directory) / "worktree"
            specs_directory = worktree_path / "app" / "specs"
            specs_directory.mkdir(parents=True)
            manifest: dict[str, object] = {"issue_number": 71}

            def update_manifest(
                issue_number: int,
                key: str,
                value: object,
            ) -> None:
                self.assertEqual(issue_number, 71)
                manifest[key] = value

            def run_skill(
                skill_name: str,
                parameter: str,
                *,
                working_directory: Path,
            ) -> str:
                if skill_name == "ontos-write-spec":
                    planning_issue = json.loads(parameter)
                    self.assertEqual(planning_issue["issue_number"], 71)
                    (specs_directory / "feature-71-json-export.md").write_text(
                        "---\nstatus: planned\n---\n",
                        encoding="utf-8",
                    )
                return "completed"

            with (
                patch.object(
                    adw,
                    "parse_args",
                    return_value=SimpleNamespace(issue_number=71),
                ),
                patch.object(adw, "switch_to_develop"),
                patch.object(
                    adw,
                    "read_issue",
                    return_value={
                        "title": "JSON export",
                        "content": "Export records as JSON.",
                        "state": "open",
                        "type": "feature",
                    },
                ),
                patch.object(
                    adw,
                    "create_issue_worktree",
                    return_value=worktree_path,
                ),
                patch.object(adw, "post_issue_comment") as post_comment,
                patch.object(
                    adw,
                    "update_issue_manifest",
                    side_effect=update_manifest,
                ),
                patch.object(
                    adw,
                    "load_issue_manifest",
                    side_effect=lambda issue_number: manifest.copy(),
                ),
                patch.object(adw, "run_codex_skill", side_effect=run_skill) as run,
            ):
                result = adw.main()

        self.assertEqual(result, 0)
        self.assertEqual(manifest["issue_number"], 71)
        self.assertEqual(manifest["title"], "JSON export")
        self.assertEqual(manifest["content"], "Export records as JSON.")
        self.assertEqual(manifest["issue_type"], "feature")
        self.assertEqual(
            manifest["branch_name"],
            "codex/feature-71-json-export",
        )
        self.assertEqual(manifest["worktree_path"], str(worktree_path))
        self.assertEqual(
            manifest["plan_file"],
            "specs/feature-71-json-export.md",
        )
        self.assertEqual(
            run.call_args_list[-1],
            call(
                "ontos-implement-spec",
                "specs/feature-71-json-export.md",
                working_directory=worktree_path / "app",
            ),
        )
        self.assertEqual(
            post_comment.call_args_list,
            [
                call(71, adw.WRITE_SPEC_COMMENT),
                call(71, adw.IMPLEMENT_SPEC_COMMENT),
                call(71, "Implementation result:\n\ncompleted"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
