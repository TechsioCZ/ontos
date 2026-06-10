#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from collections import Counter

VALID_STATUSES = {"pending", "in_progress", "completed"}
VALID_FRONTIER_STATES = {"ready", "blocked", "done", "empty", "in_progress"}
VALID_PLAN_STATUSES = {"pending", "in_progress", "completed", "warning", "empty"}
MAX_GENERATED_PLAN_COUNT_WITHOUT_CONFIRM = 64


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


@dataclass
class Todo:
    id: str = ""
    content: str = ""
    status: str = "pending"
    ordinal: int = 0


@dataclass
class Plan:
    path: str
    slug: str
    name: str = ""
    overview: str = ""
    todos: list[Todo] = field(default_factory=list)
    is_project: bool | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def completed_count(self) -> int:
        return sum(todo.status == "completed" for todo in self.todos)

    @property
    def total_count(self) -> int:
        return len(self.todos)

    @property
    def status(self) -> str:
        if any(todo.status == "in_progress" for todo in self.todos):
            return "in_progress"
        if self.todos and self.completed_count == self.total_count:
            return "completed"
        if any(todo.status not in VALID_STATUSES for todo in self.todos):
            return "warning"
        if any(todo.status == "pending" for todo in self.todos):
            return "pending"
        return "empty"

    def is_done(self) -> bool:
        return self.total_count > 0 and self.completed_count == self.total_count


@dataclass
class GeneratedPlanSpec:
    path: Path
    slug: str
    name: str
    overview: str
    todos: list[Todo]
    is_project: bool
    level: int
    node_id: str
    parent_slug: str | None = None


def parse_scalar(raw: str) -> Any:
    value = raw.strip()
    if not value:
        return ""
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if value == "[]":
        return []
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def parse_key_value(fragment: str) -> tuple[str, Any] | None:
    if ":" not in fragment:
        return None
    key, raw_value = fragment.split(":", 1)
    key = key.strip()
    if not key:
        return None
    return key, parse_scalar(raw_value)


def parse_frontmatter(text: str) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    match = re.match(r"^---\n(.*?)\n---\n?", text, re.DOTALL)
    if not match:
        return {}, ["missing YAML frontmatter"]

    lines = match.group(1).splitlines()
    data: dict[str, Any] = {}
    data["todos"] = []
    in_todos = False
    current_todo: dict[str, Any] | None = None

    def finish_current() -> None:
        nonlocal current_todo
        if current_todo is not None:
            data["todos"].append(current_todo)
            current_todo = None

    for line in lines:
        if in_todos:
            if line.startswith("  - "):
                finish_current()
                current_todo = {}
                parsed = parse_key_value(line[4:])
                if parsed:
                    key, value = parsed
                    current_todo[key] = value
                else:
                    warnings.append(f"unparsed todo line: {line.strip()}")
                continue
            if line.startswith("    "):
                if current_todo is None:
                    warnings.append(f"dangling todo field: {line.strip()}")
                    continue
                parsed = parse_key_value(line.strip())
                if parsed:
                    key, value = parsed
                    current_todo[key] = value
                else:
                    warnings.append(f"unparsed todo field: {line.strip()}")
                continue
            if not line.strip():
                continue
            finish_current()
            in_todos = False

        if not line.strip():
            continue
        parsed = parse_key_value(line)
        if not parsed:
            warnings.append(f"unparsed frontmatter line: {line.strip()}")
            continue
        key, value = parsed
        if key == "todos":
            if value == []:
                data["todos"] = []
                in_todos = False
            else:
                data["todos"] = []
                in_todos = True
        else:
            data[key] = value

    finish_current()
    return data, warnings


def slug_from_path(path: Path) -> str:
    name = path.name
    if name.endswith(".plan.md"):
        return name[:-8]
    return path.stem


def skill_root() -> Path:
    return Path(__file__).resolve().parent.parent


def plan_template_path() -> Path:
    return skill_root() / "references" / "plan-template.plan.md"


def render_text_template(template: str, replacements: dict[str, str]) -> str:
    rendered = template
    for key, value in replacements.items():
        rendered = rendered.replace(key, value)
    return rendered


def build_todo_frontmatter(todos: list[Todo]) -> str:
    lines: list[str] = []
    for todo in todos:
        lines.append(f"  - id: {todo.id}")
        lines.append(f"    content: {todo.content}")
        lines.append(f"    status: {todo.status}")
    return "\n".join(lines)


def bullet_lines(items: list[str]) -> str:
    return "\n".join(f"- {item}" for item in items)


def render_generated_plan_markdown(spec: GeneratedPlanSpec, template: str, root_slug: str) -> str:
    parent = spec.parent_slug or "none"
    execution_notes = bullet_lines(
        [
            "Keep the frontmatter as the machine-readable source of truth for todo ids, status, and the short overview.",
            f"This scaffold was generated for graph root `{root_slug}` at level {spec.level} node `{spec.node_id}`.",
            "Replace placeholder overview and todo content with concrete implementation work before using this plan for execution.",
            "Use this body for details that subagents need when reading the full file: scope boundaries, sequencing notes, references, and success criteria.",
        ]
    )
    constraints = bullet_lines(
        [
            "Record any invariants, non-goals, or protected areas that must not change while this plan is in progress.",
            f"Parent dependency for this node: `{parent}`.",
            "Keep plan-specific guidance here instead of duplicating the todo list from frontmatter.",
        ]
    )
    operator_guidance = bullet_lines(
        [
            "Refine the overview so it describes the exact outcome this plan should deliver.",
            "Replace each placeholder todo with a concrete, testable step.",
            "Add sections such as `## References`, `## Risks`, or `## Verification Notes` when the plan needs more operator context.",
        ]
    )
    return render_text_template(
        template,
        {
            "{{ name }}": spec.name,
            "{{ overview }}": spec.overview,
            "{{ todos_frontmatter }}": build_todo_frontmatter(spec.todos),
            "{{ is_project }}": "true" if spec.is_project else "false",
            "{{ execution_notes }}": execution_notes,
            "{{ constraints }}": constraints,
            "{{ operator_guidance }}": operator_guidance,
        },
    )


def parse_plan(path: Path) -> Plan:
    data, warnings = parse_frontmatter(path.read_text())
    errors: list[str] = []
    todos: list[Todo] = []
    raw_todos = data.get("todos", [])
    if not isinstance(raw_todos, list):
        warnings.append("frontmatter.todos is not a list")
        raw_todos = []
    for index, item in enumerate(raw_todos, start=1):
        if not isinstance(item, dict):
            warnings.append(f"todo #{index} is not a mapping")
            continue
        status = str(item.get("status", "pending")).strip() or "pending"
        if status not in VALID_STATUSES:
            errors.append(
                f"todo #{index} has invalid status '{status}' (expected one of: {', '.join(sorted(VALID_STATUSES))})"
            )
        todos.append(
            Todo(
                id=str(item.get("id", "")).strip(),
                content=str(item.get("content", "")).strip(),
                status=status,
                ordinal=index,
            )
        )

    name = str(data.get("name", "")).strip()
    overview = str(data.get("overview", "")).strip()
    if "status" in data:
        errors.append("frontmatter.status is not supported; status belongs on individual todos")
    if "state" in data:
        errors.append("frontmatter.state is not supported; plan state is derived from todo statuses")
    if not name:
        warnings.append("frontmatter.name is empty")
    if not overview:
        warnings.append("frontmatter.overview is empty")
    if data.get("isProject") is not None and not isinstance(data.get("isProject"), bool):
        errors.append("frontmatter.isProject is not a boolean")

    return Plan(
        path=str(path),
        slug=slug_from_path(path),
        name=name,
        overview=overview,
        todos=todos,
        is_project=data.get("isProject"),
        errors=errors,
        warnings=warnings,
    )


def generated_plan_total(depth: int, breadth: int) -> int:
    return sum(breadth**level for level in range(depth))


def build_generated_specs(args: argparse.Namespace) -> tuple[list[GeneratedPlanSpec], list[dict[str, str]]]:
    breadth = args.breadth
    depth = args.depth
    todo_count = args.todo_count
    if breadth < 1:
        raise ValueError("--breadth must be at least 1")
    if depth < 1:
        raise ValueError("--depth must be at least 1")
    if todo_count < 1:
        raise ValueError("--todo-count must be at least 1")
    total = generated_plan_total(depth, breadth)
    if total > MAX_GENERATED_PLAN_COUNT_WITHOUT_CONFIRM and not args.yes:
        raise ValueError(
            f"refusing to generate {total} plans without --yes; reduce --breadth/--depth or rerun with --yes"
        )

    title_prefix = args.title_prefix.strip() or "Generated Plan"
    slug_prefix = safe_graph_id(args.slug_prefix.strip() or title_prefix.lower())
    specs: list[GeneratedPlanSpec] = []
    edges: list[dict[str, str]] = []
    current_level: list[tuple[int, str, str | None]] = [(1, "1", None)]

    for level in range(1, depth + 1):
        next_level: list[tuple[int, str, str | None]] = []
        for ordinal, node_id, parent_slug in current_level:
            slug = slug_prefix if level == 1 else safe_graph_id(f"{slug_prefix}-l{level}-{node_id}")
            name = title_prefix if level == 1 else f"{title_prefix} L{level} Node {node_id}"
            overview = (
                f"Replace this summary with the concrete scope for the root plan `{title_prefix}`."
                if level == 1
                else f"Replace this summary with the concrete scope for level {level} node {node_id} under `{parent_slug}`."
            )
            todos = [
                Todo(
                    id=f"step-{index}",
                    content=f"Replace with concrete step {index} for {name}.",
                    status="pending",
                    ordinal=index,
                )
                for index in range(1, todo_count + 1)
            ]
            spec = GeneratedPlanSpec(
                path=args.plans_root.expanduser() / f"{slug}.plan.md",
                slug=slug,
                name=name,
                overview=overview,
                todos=todos,
                is_project=level < depth,
                level=level,
                node_id=node_id,
                parent_slug=parent_slug,
            )
            specs.append(spec)
            if parent_slug is not None:
                edges.append({"source": parent_slug, "target": slug})
            if level < depth:
                for child_index in range(1, breadth + 1):
                    next_level.append((child_index, f"{node_id}-{child_index}", slug))
        current_level = next_level

    return specs, edges


def write_generated_plans(specs: list[GeneratedPlanSpec], overwrite: bool) -> tuple[list[Path], list[Path]]:
    template = plan_template_path().read_text()
    root_slug = specs[0].slug if specs else "generated-plan"
    created: list[Path] = []
    overwritten: list[Path] = []
    for spec in specs:
        spec.path.parent.mkdir(parents=True, exist_ok=True)
        existed = spec.path.exists()
        if existed and not overwrite:
            raise FileExistsError(f"plan already exists: {spec.path} (rerun with --yes to overwrite)")
        spec.path.write_text(render_generated_plan_markdown(spec, template, root_slug))
        if existed:
            overwritten.append(spec.path)
        else:
            created.append(spec.path)
    return created, overwritten


def resolve_plan_paths(plans_root: Path, explicit_plans: list[str], globs: list[str]) -> list[Path]:
    if explicit_plans:
        paths = [
            resolved
            for plan in explicit_plans
            for resolved in [Path(plan).expanduser().resolve()]
            if resolved.name.endswith(".plan.md")
        ]
    else:
        patterns = globs or ["*.plan.md"]
        paths = []
        for entry in sorted(plans_root.glob("*.plan.md")):
            if any(fnmatch.fnmatch(entry.name, pattern) for pattern in patterns):
                paths.append(entry.resolve())
    return sorted(dict.fromkeys(paths))


def build_aliases(plans: list[Plan]) -> dict[str, Plan]:
    aliases: dict[str, Plan] = {}
    for plan in plans:
        keys = {
            plan.slug,
            Path(plan.path).name,
            plan.path,
        }
        if plan.name:
            keys.add(plan.name)
        for key in keys:
            aliases[key] = plan
    return aliases


def parse_dependencies(dep_args: list[str], plans: list[Plan]) -> tuple[list[dict[str, str]], list[str]]:
    aliases = build_aliases(plans)
    warnings: list[str] = []
    edges: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for raw in dep_args:
        if ":" not in raw:
            warnings.append(f"invalid dependency '{raw}' (expected source:target)")
            continue
        source_key, target_key = raw.split(":", 1)
        source = aliases.get(source_key)
        target = aliases.get(target_key)
        if source is None or target is None:
            warnings.append(f"unresolved dependency '{raw}'")
            continue
        edge = (source.slug, target.slug)
        if edge in seen:
            continue
        seen.add(edge)
        edges.append({"source": source.slug, "target": target.slug})
    return edges, warnings


def dependencies_satisfied(plan: Plan, plan_map: dict[str, Plan], edges: list[dict[str, str]]) -> tuple[bool, list[str]]:
    blockers: list[str] = []
    for edge in edges:
        if edge["target"] != plan.slug:
            continue
        upstream = plan_map[edge["source"]]
        if not upstream.is_done():
            blockers.append(upstream.slug)
    return not blockers, blockers


def frontier_for_plan(plan: Plan, max_depth: int) -> dict[str, Any]:
    active = [todo for todo in plan.todos if todo.status == "in_progress"]
    if not active:
        for todo in plan.todos:
            if todo.status != "completed":
                active = [todo]
                break

    active_ids = {todo.ordinal for todo in active}
    upcoming: list[Todo] = []
    if active:
        anchor = max(todo.ordinal for todo in active)
        for todo in plan.todos:
            if todo.ordinal <= anchor:
                continue
            if todo.status == "pending":
                upcoming.append(todo)
            if len(upcoming) >= max_depth:
                break

    return {
        "active": [asdict(todo) for todo in active],
        "upcoming": [asdict(todo) for todo in upcoming],
        "active_ordinals": sorted(active_ids),
    }


def plan_degree_map(plans: list[Plan], edges: list[dict[str, str]]) -> dict[str, int]:
    degrees = {plan.slug: 0 for plan in plans}
    for edge in edges:
        source = edge["source"]
        target = edge["target"]
        if source in degrees:
            degrees[source] += 1
        if target in degrees:
            degrees[target] += 1
    return degrees


def orphaned_plan_slugs(plans: list[Plan], edges: list[dict[str, str]]) -> list[str]:
    if len(plans) <= 1:
        return []
    degrees = plan_degree_map(plans, edges)
    return sorted(slug for slug, degree in degrees.items() if degree == 0)


def graph_integrity_warnings(plans: list[Plan], edges: list[dict[str, str]]) -> list[str]:
    warnings: list[str] = []

    slug_counts = Counter(plan.slug for plan in plans)
    for slug, count in sorted(slug_counts.items()):
        if count > 1:
            warnings.append(f"duplicate plan slug '{slug}' appears {count} times")

    name_counts = Counter(plan.name for plan in plans if plan.name)
    for name, count in sorted(name_counts.items()):
        if count > 1:
            warnings.append(f"duplicate plan name '{name}' appears {count} times")

    for plan in plans:
        todo_id_counts = Counter(todo.id for todo in plan.todos if todo.id)
        for todo_id, count in sorted(todo_id_counts.items()):
            if count > 1:
                warnings.append(f"{plan.slug}: duplicate todo id '{todo_id}' appears {count} times")

        for todo in plan.todos:
            if not todo.content:
                label = todo.id or f"todo-{todo.ordinal}"
                warnings.append(f"{plan.slug}: {label} has empty content")

    adjacency: dict[str, list[str]] = {plan.slug: [] for plan in plans}
    for edge in edges:
        source = edge["source"]
        target = edge["target"]
        if source == target:
            warnings.append(f"self dependency detected for '{source}'")
        adjacency.setdefault(source, []).append(target)
        adjacency.setdefault(target, [])

    visiting: list[str] = []
    visited: set[str] = set()
    cycle_signatures: set[tuple[str, ...]] = set()

    def canonical_cycle(cycle: list[str]) -> tuple[str, ...]:
        rotated_variants: list[tuple[str, ...]] = []
        for index in range(len(cycle)):
            rotated = tuple(cycle[index:] + cycle[:index])
            rotated_variants.append(rotated)
        reversed_cycle = list(reversed(cycle))
        for index in range(len(reversed_cycle)):
            rotated = tuple(reversed_cycle[index:] + reversed_cycle[:index])
            rotated_variants.append(rotated)
        return min(rotated_variants)

    def walk(node: str) -> None:
        if node in visited:
            return
        if node in visiting:
            cycle = visiting[visiting.index(node) :]
            signature = canonical_cycle(cycle)
            if signature not in cycle_signatures:
                cycle_signatures.add(signature)
                warnings.append(f"dependency cycle detected: {' -> '.join(cycle + [node])}")
            return

        visiting.append(node)
        for nxt in adjacency.get(node, []):
            walk(nxt)
        visiting.pop()
        visited.add(node)

    for slug in sorted(adjacency):
        walk(slug)

    return warnings


def graph_integrity_errors(plans: list[Plan], edges: list[dict[str, str]]) -> list[str]:
    errors: list[str] = []
    for plan in plans:
        errors.extend(f"{plan.slug}: {error}" for error in plan.errors)
    for slug in orphaned_plan_slugs(plans, edges):
        errors.append(
            f"{slug}: selected plan is orphaned (no upstream or downstream edges); link it explicitly or exclude it from the graph selection"
        )
    return errors


def snapshot_integrity_errors(snapshot: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for plan in snapshot.get("plans", []):
        slug = plan.get("slug", "<unknown-plan>")
        plan_status = plan.get("status")
        if plan_status not in VALID_PLAN_STATUSES:
            errors.append(
                f"{slug}: derived plan status '{plan_status}' is invalid (expected one of: {', '.join(sorted(VALID_PLAN_STATUSES))})"
            )
        for todo in plan.get("todos", []):
            todo_id = todo.get("id") or f"todo-{todo.get('ordinal', '?')}"
            status = todo.get("status")
            if status not in VALID_STATUSES:
                errors.append(
                    f"{slug}: {todo_id} has invalid status '{status}' in snapshot output"
                )
    for item in snapshot.get("frontier", []):
        plan_slug = item.get("plan_slug", "<unknown-plan>")
        state = item.get("state")
        if state not in VALID_FRONTIER_STATES:
            errors.append(
                f"{plan_slug}: frontier state '{state}' is invalid (expected one of: {', '.join(sorted(VALID_FRONTIER_STATES))})"
            )
        plan_status = item.get("plan_status")
        if plan_status not in VALID_PLAN_STATUSES:
            errors.append(
                f"{plan_slug}: frontier plan_status '{plan_status}' is invalid (expected one of: {', '.join(sorted(VALID_PLAN_STATUSES))})"
            )
    return errors


def build_snapshot(plans: list[Plan], edges: list[dict[str, str]], args: argparse.Namespace) -> dict[str, Any]:
    plan_map = {plan.slug: plan for plan in plans}
    frontier_items: list[dict[str, Any]] = []
    validation_warnings: list[str] = []
    validation_errors: list[str] = graph_integrity_errors(plans, edges)
    for plan in plans:
        validation_warnings.extend(f"{plan.slug}: {warning}" for warning in plan.warnings)

    for plan in plans:
        allowed, blockers = dependencies_satisfied(plan, plan_map, edges)
        frontier = frontier_for_plan(plan, args.max_depth)
        state = "ready" if allowed else "blocked"
        if not frontier["active"]:
            state = "done" if plan.is_done() else "empty"
        if any(item["status"] == "in_progress" for item in frontier["active"]):
            state = "in_progress" if allowed else "blocked"
        frontier_items.append(
            {
                "plan_slug": plan.slug,
                "plan_name": plan.name or plan.slug,
                "plan_path": plan.path,
                "plan_status": plan.status,
                "state": state,
                "blocked_by": blockers,
                "active": frontier["active"],
                "upcoming": frontier["upcoming"],
                "completed": plan.completed_count,
                "total": plan.total_count,
            }
        )

    frontier_items.sort(
        key=lambda item: (
            {"in_progress": 0, "ready": 1, "blocked": 2, "done": 3, "empty": 4}.get(item["state"], 9),
            item["plan_name"].lower(),
        )
    )
    if args.lanes > 0:
        frontier_items = frontier_items[: args.lanes]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "graph_id": args.graph_id,
        "plan_set_hash": plan_set_hash(plans),
        "selection_hash": selection_hash(plans, edges),
        "plan_count": len(plans),
        "edge_count": len(edges),
        "plans_root": str(args.plans_root.expanduser()),
        "selected_globs": list(args.glob),
        "selected_plan_paths": [plan.path for plan in plans],
        "edges": edges,
        "plans": [asdict(plan) for plan in plans],
        "frontier": frontier_items,
        "errors": validation_errors,
        "warnings": validation_warnings,
    }


def render_summary(snapshot: dict[str, Any]) -> str:
    lines: list[str] = []
    for plan in snapshot["plans"]:
        name = plan["name"] or plan["slug"]
        completed = sum(todo["status"] == "completed" for todo in plan["todos"])
        total = len(plan["todos"])
        lines.append(f"{name} [{completed}/{total}] ({plan['path']})")
        if plan["warnings"]:
            lines.extend(f"  warning: {warning}" for warning in plan["warnings"])
    if snapshot["errors"]:
        lines.append("")
        lines.append("validation errors:")
        lines.extend(f"  - {error}" for error in snapshot["errors"])
    if snapshot["warnings"]:
        lines.append("")
        lines.append("validation warnings:")
        lines.extend(f"  - {warning}" for warning in snapshot["warnings"])
    return "\n".join(lines)


def render_frontier(snapshot: dict[str, Any]) -> str:
    lines: list[str] = []
    for item in snapshot["frontier"]:
        header = f"{item['plan_name']} [{item['state']}]"
        if item["blocked_by"]:
            header += f" blocked_by={','.join(item['blocked_by'])}"
        lines.append(header)
        for active in item["active"]:
            label = active["id"] or f"todo-{active['ordinal']}"
            lines.append(f"  active: {label} [{active['status']}] {active['content']}")
        for upcoming in item["upcoming"]:
            label = upcoming["id"] or f"todo-{upcoming['ordinal']}"
            lines.append(f"  next:   {label} [{upcoming['status']}] {upcoming['content']}")
        if not item["active"] and not item["upcoming"]:
            lines.append("  no remaining todos")
    if snapshot["errors"]:
        lines.append("")
        lines.append("errors:")
        lines.extend(f"  - {error}" for error in snapshot["errors"])
    if snapshot["warnings"]:
        lines.append("")
        lines.append("warnings:")
        lines.extend(f"  - {warning}" for warning in snapshot["warnings"])
    return "\n".join(lines)


def render_dag_text(snapshot: dict[str, Any]) -> str:
    frontier_by_plan = {item["plan_slug"]: item for item in snapshot["frontier"]}
    upstream_by_plan: dict[str, list[str]] = {}
    downstream_by_plan: dict[str, list[str]] = {}
    for edge in snapshot["edges"]:
        source = edge["source"]
        target = edge["target"]
        upstream_by_plan.setdefault(target, []).append(source)
        downstream_by_plan.setdefault(source, []).append(target)

    lines: list[str] = []
    for plan in snapshot["plans"]:
        plan_name = plan["name"] or plan["slug"]
        frontier = frontier_by_plan.get(plan["slug"], {})
        completed = sum(todo["status"] == "completed" for todo in plan["todos"])
        total = len(plan["todos"])
        header = f"{plan_name} [{frontier.get('state', frontier.get('plan_status', 'unknown'))}] {completed}/{total}"
        blocked_by = frontier.get("blocked_by") or []
        if blocked_by:
            header += f" blocked_by={','.join(blocked_by)}"
        lines.append(header)

        upstream = upstream_by_plan.get(plan["slug"]) or []
        if upstream:
            lines.append(f"  upstream: {', '.join(upstream)}")
        downstream = downstream_by_plan.get(plan["slug"]) or []
        if downstream:
            lines.append(f"  downstream: {', '.join(downstream)}")

        if plan["todos"]:
            for todo in plan["todos"]:
                label = todo["id"] or f"todo-{todo['ordinal']}"
                lines.append(f"  {todo['ordinal']}. {label} [{todo['status']}] {todo['content']}")
        else:
            lines.append("  no todos")

        warnings = plan.get("warnings") or []
        lines.extend(f"  warning: {warning}" for warning in warnings)

    if snapshot["edges"]:
        lines.append("")
        lines.append("inter-plan edges:")
        for edge in snapshot["edges"]:
            lines.append(f"  {edge['source']} -> {edge['target']}")

    if snapshot["errors"]:
        lines.append("")
        lines.append("errors:")
        lines.extend(f"  - {error}" for error in snapshot["errors"])

    if snapshot["warnings"]:
        lines.append("")
        lines.append("warnings:")
        lines.extend(f"  - {warning}" for warning in snapshot["warnings"])

    return "\n".join(lines)


def render_generate_text(snapshot: dict[str, Any]) -> str:
    created = snapshot.get("created_plan_paths", [])
    overwritten = snapshot.get("overwritten_plan_paths", [])
    lines = [
        f"Generated {len(snapshot.get('plans', []))} plan files for graph {snapshot.get('graph_id', '(unresolved)')}",
        f"  template: {snapshot.get('template_path', '(unknown)')}",
    ]
    if created:
        lines.append("created plans:")
        lines.extend(f"  - {path}" for path in created)
    if overwritten:
        lines.append("overwritten plans:")
        lines.extend(f"  - {path}" for path in overwritten)
    lines.append("")
    lines.extend(render_dag_text(snapshot).splitlines())
    append_handoff_state(lines, snapshot)
    return "\n".join(lines)


def render_mermaid(snapshot: dict[str, Any]) -> str:
    lines = ["flowchart TD"]
    edges = snapshot["edges"]
    edge_lookup = {(edge["source"], edge["target"]) for edge in edges}

    for plan in snapshot["plans"]:
        plan_id = f"plan_{plan['slug'].replace('-', '_')}"
        title = plan["name"] or plan["slug"]
        lines.append(f'  subgraph {plan_id}["{title}"]')
        previous_id = ""
        for todo in plan["todos"]:
            todo_id = f"{plan_id}_todo_{todo['ordinal']}"
            todo_label = todo["id"] or f"todo-{todo['ordinal']}"
            status = todo["status"]
            content = todo["content"].replace('"', "'")
            lines.append(f'    {todo_id}["{todo_label} ({status})\\n{content}"]')
            if previous_id:
                lines.append(f"    {previous_id} --> {todo_id}")
            previous_id = todo_id
        if not plan["todos"]:
            lines.append(f'    {plan_id}_empty["no todos"]')
        lines.append("  end")

    plan_first_nodes = {}
    plan_last_nodes = {}
    for plan in snapshot["plans"]:
        plan_id = f"plan_{plan['slug'].replace('-', '_')}"
        if plan["todos"]:
            plan_first_nodes[plan["slug"]] = f"{plan_id}_todo_1"
            plan_last_nodes[plan["slug"]] = f"{plan_id}_todo_{len(plan['todos'])}"
        else:
            plan_first_nodes[plan["slug"]] = f"{plan_id}_empty"
            plan_last_nodes[plan["slug"]] = f"{plan_id}_empty"

    for source, target in sorted(edge_lookup):
        lines.append(f"  {plan_last_nodes[source]} --> {plan_first_nodes[target]}")

    return "\n".join(lines)


def parse_timestamp(raw: str) -> datetime:
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return datetime.fromtimestamp(0, tz=timezone.utc)


def safe_graph_id(raw: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", raw.strip())
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-")
    return cleaned or "plan-graph"


def plan_set_hash(plans: list[Plan]) -> str:
    joined = "\n".join(sorted(plan.path for plan in plans))
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:10]


def selection_hash(plans: list[Plan], edges: list[dict[str, str]]) -> str:
    payload = {
        "selected_plan_paths": sorted(plan.path for plan in plans),
        "edges": sorted((edge["source"], edge["target"]) for edge in edges),
    }
    joined = json.dumps(payload, sort_keys=True)
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:10]


def suggested_graph_id(plans: list[Plan], edges: list[dict[str, str]]) -> str:
    if not plans:
        return "plan-graph"
    if len(plans) == 1:
        base = plans[0].slug
    else:
        base = f"{plans[0].slug}-plus-{len(plans) - 1}-plans"
    return safe_graph_id(f"{base}-{selection_hash(plans, edges)}")


def graph_snapshot_path(graph_id: str, state_root: Path) -> Path:
    return state_root / safe_graph_id(graph_id) / "snapshot.json"


def load_saved_graph_entries(state_root: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    root = state_root.expanduser()
    if not root.exists():
        return entries
    for snapshot_path in sorted(root.glob("*/snapshot.json")):
        try:
            snapshot = json.loads(snapshot_path.read_text())
        except Exception:
            continue
        plans = snapshot.get("plans", [])
        selected_plan_paths = snapshot.get("selected_plan_paths", [])
        if not isinstance(selected_plan_paths, list):
            selected_plan_paths = []
        edges = snapshot.get("edges", [])
        if not isinstance(edges, list):
            edges = []
        graph_id = snapshot.get("graph_id") or snapshot_path.parent.name
        generated_at = str(snapshot.get("generated_at") or "")
        entries.append(
            {
                "graph_id": str(graph_id),
                "generated_at": generated_at,
                "generated_at_sort": parse_timestamp(generated_at),
                "snapshot_path": str(snapshot_path),
                "state_path": str(snapshot_path),
                "state_dir": str(snapshot_path.parent),
                "selected_plan_paths": [str(path) for path in selected_plan_paths],
                "edges": [
                    {
                        "source": str(edge.get("source") or "").strip(),
                        "target": str(edge.get("target") or "").strip(),
                    }
                    for edge in edges
                    if isinstance(edge, dict)
                ],
                "plan_set_hash": str(snapshot.get("plan_set_hash") or ""),
                "selection_hash": str(snapshot.get("selection_hash") or ""),
                "plan_names": [
                    str(plan.get("name") or plan.get("slug") or "").strip()
                    for plan in plans
                    if isinstance(plan, dict)
                ],
                "plan_count": len(plans) if isinstance(plans, list) else 0,
            }
        )
    entries.sort(key=lambda entry: entry["generated_at_sort"], reverse=True)
    return entries


def find_saved_graph_for_selection(
    plans: list[Plan],
    edges: list[dict[str, str]],
    state_root: Path,
) -> dict[str, Any] | None:
    wanted = sorted(plan.path for plan in plans)
    wanted_edges = sorted((edge["source"], edge["target"]) for edge in edges)
    for entry in load_saved_graph_entries(state_root):
        entry_edges = sorted((edge["source"], edge["target"]) for edge in entry["edges"])
        if sorted(entry["selected_plan_paths"]) == wanted and entry_edges == wanted_edges:
            return entry
    return None


def load_snapshot_by_graph_id(graph_id: str, state_root: Path) -> dict[str, Any] | None:
    snapshot_path = graph_snapshot_path(graph_id, state_root.expanduser())
    if not snapshot_path.exists():
        return None
    try:
        snapshot = json.loads(snapshot_path.read_text())
    except Exception:
        return None
    snapshot["graph_id"] = graph_id
    snapshot["snapshot_path"] = str(snapshot_path)
    snapshot["state_path"] = str(snapshot_path)
    snapshot["state_dir"] = str(snapshot_path.parent)
    return snapshot


def render_plans_listing(plans: list[Plan]) -> str:
    name_counts: dict[str, int] = {}
    for plan in plans:
        if plan.name:
            name_counts[plan.name] = name_counts.get(plan.name, 0) + 1
    lines: list[str] = []
    for plan in plans:
        label = plan.name or plan.slug
        duplicate = " duplicate-name" if plan.name and name_counts.get(plan.name, 0) > 1 else ""
        lines.append(
            f"{label} [{plan.completed_count}/{plan.total_count}] status={plan.status}{duplicate} ({plan.path})"
        )
        if plan.warnings:
            lines.extend(f"  warning: {warning}" for warning in plan.warnings)
    return "\n".join(lines)


def render_graphs_listing(entries: list[dict[str, Any]]) -> str:
    if not entries:
        return "No saved graph snapshots."
    lines: list[str] = []
    for entry in entries:
        plans = ", ".join(name for name in entry["plan_names"] if name) or "(unnamed plans)"
        selection_hash_value = entry.get("selection_hash") or "unknown"
        lines.append(
            f"{entry['graph_id']} [{entry['plan_count']} plans] updated={entry['generated_at']} selection={selection_hash_value} ({entry['snapshot_path']})"
        )
        lines.append(f"  plans: {plans}")
        edges = entry.get("edges") or []
        if edges:
            rendered_edges = ", ".join(f"{edge['source']}->{edge['target']}" for edge in edges)
            lines.append(f"  depends: {rendered_edges}")
    return "\n".join(lines)


def render_delete_plan_result(
    matched_paths: list[Path],
    deleted_paths: list[Path],
    dry_run: bool,
    errors: list[str],
) -> str:
    lines: list[str] = []
    if dry_run:
        lines.append("delete preview:")
        lines.extend(f"  {path}" for path in matched_paths)
        lines.append("")
        lines.append("rerun with --yes to delete these plan files.")
    else:
        lines.append("deleted plans:")
        lines.extend(f"  {path}" for path in deleted_paths)

    if errors:
        lines.append("")
        lines.append("errors:")
        lines.extend(f"  {error}" for error in errors)

    lines.append("")
    lines.append("saved graph snapshots were not changed.")
    return "\n".join(lines)


def append_handoff_state(lines: list[str], snapshot: dict[str, Any]) -> None:
    graph_id = snapshot.get("graph_id")
    graph_source = snapshot.get("graph_source")
    selection_hash_value = snapshot.get("selection_hash")
    state_dir = snapshot.get("state_dir")
    snapshot_path = snapshot.get("snapshot_path") or snapshot.get("state_path")
    selected_plan_paths = snapshot.get("selected_plan_paths") or []
    selected_globs = snapshot.get("selected_globs") or []
    if not graph_id and not graph_source and not selection_hash_value and not state_dir and not snapshot_path:
        return
    lines.append("")
    lines.append("handoff state:")
    if graph_id:
        lines.append(f"  resolved graph id: {graph_id}")
    if graph_source:
        lines.append(f"  graph source: {graph_source}")
    if selection_hash_value:
        lines.append(f"  selection hash: {selection_hash_value}")
    if state_dir:
        lines.append(f"  state dir: {state_dir}")
    if snapshot_path:
        lines.append(f"  snapshot path: {snapshot_path}")
    if selected_plan_paths:
        lines.append(f"  selected plan count: {len(selected_plan_paths)}")
    elif selected_globs:
        lines.append(f"  selected globs: {', '.join(selected_globs)}")


def write_state(snapshot: dict[str, Any], graph_id: str, state_root: Path) -> Path:
    graph_dir = state_root / safe_graph_id(graph_id)
    graph_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = graph_dir / "snapshot.json"
    snapshot_path.write_text(json.dumps(snapshot, indent=2) + "\n")
    return snapshot_path


def delete_plan_files(plan_paths: list[Path]) -> tuple[list[Path], list[str]]:
    deleted: list[Path] = []
    errors: list[str] = []
    for path in plan_paths:
        try:
            path.unlink()
            deleted.append(path)
        except FileNotFoundError:
            errors.append(f"missing: {path}")
        except Exception as exc:
            errors.append(f"{path}: {exc}")
    return deleted, errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build, validate, and visualize DAGs and frontiers from plan markdown files."
    )
    parser.add_argument("mode", choices=["summary", "dag", "frontier", "validate", "plans", "graphs", "delete-plan", "generate"])
    parser.add_argument(
        "--plans-root",
        type=Path,
        default=default_plans_root(),
        help="Plan root (default: CODEX_PLANS_ROOT, CODEX_HOME/plans, or ./.codex/plans)",
    )
    parser.add_argument("--plan", action="append", default=[], help="Explicit plan path (repeatable)")
    parser.add_argument("--glob", action="append", default=[], help="Filename glob under plans root (repeatable)")
    parser.add_argument("--depends", action="append", default=[], help="Explicit dependency edge source:target")
    parser.add_argument("--lanes", type=int, default=0, help="Limit frontier items returned")
    parser.add_argument("--max-depth", type=int, default=2, help="Upcoming pending todos to show after the active one")
    parser.add_argument(
        "--format",
        choices=["text", "json", "mermaid"],
        default="text",
        help="Output format; use 'mermaid' to render a visual dependency graph.",
    )
    parser.add_argument("--graph-id", default=os.environ.get("GRAPH_ID", ""))
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=default_state_root(),
        help="Snapshot root (default: CODEX_PLAN_GRAPHS_ROOT, CODEX_HOME/plan-graphs, or ./.codex/plan-graphs)",
    )
    parser.add_argument("--write-state", action="store_true")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--yes", action="store_true", help="Confirm destructive actions such as delete-plan")
    parser.add_argument("--breadth", type=int, default=2, help="For generate: number of child plans per non-leaf plan")
    parser.add_argument("--depth", type=int, default=2, help="For generate: number of plan layers to scaffold")
    parser.add_argument("--todo-count", type=int, default=3, help="For generate: number of pending todos per generated plan")
    parser.add_argument("--title-prefix", default="Generated Plan", help="For generate: base human-readable plan name")
    parser.add_argument("--slug-prefix", default="generated-plan", help="For generate: base slug used for generated plan filenames")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    state_root = args.state_dir.expanduser()

    if args.mode == "graphs":
        entries = load_saved_graph_entries(state_root)
        if args.format == "json":
            print(json.dumps(entries, indent=2, default=str))
        else:
            print(render_graphs_listing(entries))
        return 0

    if args.mode == "generate":
        try:
            specs, edges = build_generated_specs(args)
            created, overwritten = write_generated_plans(specs, overwrite=args.yes)
        except Exception as exc:
            print(str(exc), file=sys.stderr)
            return 1

        plans = [parse_plan(spec.path) for spec in specs]
        snapshot = build_snapshot(plans, edges, args)
        resolved_graph_id = args.graph_id or suggested_graph_id(plans, edges)
        snapshot["graph_id"] = resolved_graph_id
        snapshot["graph_source"] = "generated-plan-set"
        snapshot["created_plan_paths"] = [str(path) for path in created]
        snapshot["overwritten_plan_paths"] = [str(path) for path in overwritten]
        snapshot["template_path"] = str(plan_template_path())
        state_path = write_state(snapshot, resolved_graph_id, state_root)
        snapshot["snapshot_path"] = str(state_path)
        snapshot["state_path"] = str(state_path)
        snapshot["state_dir"] = str(state_path.parent)

        if args.format == "json":
            print(json.dumps(snapshot, indent=2))
        else:
            print(render_generate_text(snapshot))
        return 0

    plan_paths = resolve_plan_paths(args.plans_root.expanduser(), args.plan, args.glob)

    if args.mode == "plans":
        if not plan_paths:
            print("No plan files matched.", file=sys.stderr)
            return 1
        plans = [parse_plan(path) for path in plan_paths]
        if args.format == "json":
            print(json.dumps([asdict(plan) for plan in plans], indent=2))
        else:
            print(render_plans_listing(plans))
        return 0

    if args.mode == "delete-plan":
        if not plan_paths:
            print("No plan files matched.", file=sys.stderr)
            return 1
        if args.format == "json":
            if args.yes:
                deleted, errors = delete_plan_files(plan_paths)
                print(
                    json.dumps(
                        {
                            "dry_run": False,
                            "matched_plan_paths": [str(path) for path in plan_paths],
                            "deleted_plan_paths": [str(path) for path in deleted],
                            "errors": errors,
                            "saved_graphs_untouched": True,
                        },
                        indent=2,
                    )
                )
                return 0 if not errors else 1
            print(
                json.dumps(
                    {
                        "dry_run": True,
                        "matched_plan_paths": [str(path) for path in plan_paths],
                        "deleted_plan_paths": [],
                        "errors": [],
                        "saved_graphs_untouched": True,
                        "next_step": "rerun with --yes to delete matched plans",
                    },
                    indent=2,
                )
            )
            return 0

        if not args.yes:
            print(render_delete_plan_result(plan_paths, [], True, []))
            return 0

        deleted, errors = delete_plan_files(plan_paths)
        print(render_delete_plan_result(plan_paths, deleted, False, errors))
        return 0 if not errors else 1

    if not plan_paths and args.graph_id and args.mode in {"summary", "dag", "frontier"}:
        snapshot = load_snapshot_by_graph_id(args.graph_id, state_root)
        if snapshot is None:
            print(f"No saved snapshot found for graph '{args.graph_id}'.", file=sys.stderr)
            return 1
        if args.format == "json":
            print(json.dumps(snapshot, indent=2))
            return 0
        if args.mode == "summary":
            lines = render_summary(snapshot).splitlines()
            append_handoff_state(lines, snapshot)
            print("\n".join(lines))
            return 0
        if args.mode == "frontier":
            lines = render_frontier(snapshot).splitlines()
            append_handoff_state(lines, snapshot)
            print("\n".join(lines))
            return 0
        if args.mode == "dag":
            if args.format == "mermaid":
                print(render_mermaid(snapshot))
            else:
                lines = render_dag_text(snapshot).splitlines()
                append_handoff_state(lines, snapshot)
                print("\n".join(lines))
            return 0

    if not plan_paths:
        print("No plan files matched.", file=sys.stderr)
        return 1

    plans = [parse_plan(path) for path in plan_paths]
    edges, dep_warnings = parse_dependencies(args.depends, plans)
    snapshot = build_snapshot(plans, edges, args)
    snapshot["warnings"].extend(dep_warnings)
    snapshot["warnings"].extend(graph_integrity_warnings(plans, edges))
    graph_source = "explicit" if args.graph_id else "ephemeral"

    if args.mode in {"summary", "dag", "frontier"}:
        resolved_graph_id = args.graph_id
        if not resolved_graph_id:
            existing = find_saved_graph_for_selection(plans, edges, state_root)
            if existing is not None:
                resolved_graph_id = existing["graph_id"]
                graph_source = "matched-plan-set"
            else:
                resolved_graph_id = suggested_graph_id(plans, edges)
                graph_source = "generated-selection"
        snapshot["graph_id"] = resolved_graph_id
        snapshot["graph_source"] = graph_source

    should_write_state = args.write_state or (args.mode in {"summary", "dag", "frontier"} and not args.graph_id)
    if should_write_state:
        state_path = write_state(snapshot, snapshot["graph_id"], state_root)
        snapshot["snapshot_path"] = str(state_path)
        snapshot["state_path"] = str(state_path)
        snapshot["state_dir"] = str(state_path.parent)
    elif args.graph_id:
        state_path = graph_snapshot_path(args.graph_id, state_root)
        if state_path.exists():
            snapshot["snapshot_path"] = str(state_path)
            snapshot["state_path"] = str(state_path)
            snapshot["state_dir"] = str(state_path.parent)

    if args.mode == "validate":
        if args.format == "json":
            print(
                json.dumps(
                    {
                        "errors": snapshot["errors"],
                        "warnings": snapshot["warnings"],
                        "plan_count": len(plans),
                    },
                    indent=2,
                )
            )
        else:
            if snapshot["errors"]:
                print("\n".join(snapshot["errors"]))
                if snapshot["warnings"]:
                    print("")
            if snapshot["warnings"]:
                print("\n".join(snapshot["warnings"]))
            if not snapshot["errors"] and not snapshot["warnings"]:
                print("All selected plans parsed cleanly.")
        return 1 if snapshot["errors"] or (args.strict and snapshot["warnings"]) else 0

    if args.format == "json":
        print(json.dumps(snapshot, indent=2))
        return 0

    if args.mode == "summary":
        lines = render_summary(snapshot).splitlines()
        append_handoff_state(lines, snapshot)
        print("\n".join(lines))
        return 0
    if args.mode == "frontier":
        lines = render_frontier(snapshot).splitlines()
        append_handoff_state(lines, snapshot)
        print("\n".join(lines))
        return 0
    if args.mode == "dag":
        if args.format == "mermaid":
            print(render_mermaid(snapshot))
        else:
            lines = render_dag_text(snapshot).splitlines()
            append_handoff_state(lines, snapshot)
            print("\n".join(lines))
        return 0

    print(f"Unsupported mode: {args.mode}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
