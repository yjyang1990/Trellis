"""Plan, preview and apply task directory renames and their references."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .io import read_json_checked, write_json
from .log import Colors, colored
from .paths import DIR_ARCHIVE, DIR_WORKFLOW, FILE_TASK_JSON, get_repo_root, get_tasks_dir
from .task_store_helpers import (
    _find_archived_task_by_dir_name,
    _repo_relative_path,
    _report_read_failure,
    _report_write_failure,
)
from .task_utils import (
    is_within_tasks_dir,
    resolve_task_dir,
)


# task.json fields that carry the task's own slug. The directory name carries
# it too, prefixed with the creation date; everything else that names the task
# (parent / children / subtasks in *other* tasks, jsonl paths) stores the full
# directory name instead.
RENAME_IDENTITY_FIELDS: tuple[str, ...] = ("id", "name")

_JSONL_NAMES: tuple[str, ...] = ("implement.jsonl", "check.jsonl")


@dataclass
class _RenamePlan:
    """Every change a rename would make, computed before anything is written.

    ``--dry-run`` and the real run render their output from this one structure,
    so the printed change set cannot drift from the applied one.
    """

    task_dir: Path
    new_dir: Path
    old_name: str
    new_name: str
    old_rel: str
    new_rel: str
    task_json_path: Path
    task_data: dict
    # (field, current value, new value) for each identity field that changes.
    identity: list[tuple[str, object, str]] = field(default_factory=list)
    # (jsonl path, changed line numbers, full new file text)
    jsonl: list[tuple[Path, list[int], str]] = field(default_factory=list)
    # (other task's task.json, rewritten data, labels of the changed refs)
    backrefs: list[tuple[Path, dict, list[str]]] = field(default_factory=list)
    # (file, line number) of old-name mentions elsewhere under .trellis/
    reported: list[tuple[Path, int]] = field(default_factory=list)
    # Task dirs whose task.json could not be read, so back-refs in them are
    # neither rewritten nor ruled out.
    unreadable: list[Path] = field(default_factory=list)


def _split_date_prefix(dir_name: str) -> tuple[str, str]:
    """Split ``MM-DD-slug`` into ``("MM-DD", "slug")``.

    Returns ``("", dir_name)`` when there is no plausible date prefix, so a
    hand-made directory name without one is renamed to the bare slug.
    """
    m = re.match(r"^(\d{2})-(\d{2})-(.+)$", dir_name)
    if m and 1 <= int(m.group(1)) <= 12 and 1 <= int(m.group(2)) <= 31:
        return f"{m.group(1)}-{m.group(2)}", m.group(3)
    return "", dir_name


def _validate_rename_slug(slug: str, date_prefix: str) -> str | None:
    """Return the slug body to rename to, or None after reporting the refusal.

    Mirrors ``create``'s ``--slug`` handling: no path separators or ``..`` (the
    slug is joined into a directory name), and a pasted-in date prefix is
    normalized away rather than doubled — but a rename keeps the task's
    *original* creation date, not today's.
    """
    if not slug:
        print(colored("Error: new slug is required", Colors.RED), file=sys.stderr)
        return None

    if "/" in slug or "\\" in slug or ".." in slug:
        print(
            colored(
                f"Error: <new-slug> must be a plain name without path separators or '..': {slug}",
                Colors.RED,
            ),
            file=sys.stderr,
        )
        return None

    slug_prefix, body = _split_date_prefix(slug)
    if not slug_prefix:
        return slug
    if slug_prefix == date_prefix:
        print(
            colored(
                f'warning: <new-slug> should not include the MM-DD prefix; normalized to "{body}"',
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )
        return body
    print(
        colored(
            f"Error: <new-slug> starts with a date prefix ({slug_prefix}-), but rename keeps "
            f"the task's own creation date ({date_prefix}).",
            Colors.RED,
        ),
        file=sys.stderr,
    )
    print(f"Pass only the slug body, e.g. {body}", file=sys.stderr)
    return None


def _plan_jsonl_rewrites(
    task_dir: Path, old_rel: str, new_rel: str
) -> list[tuple[Path, list[int], str]]:
    """Plan rewrites of context entries pointing under the old task directory.

    Matching on ``<old path>/`` rather than the bare path keeps a sibling task
    whose name merely starts with this one's out of the rewrite.
    """
    rewrites: list[tuple[Path, list[int], str]] = []
    needle = f"{old_rel}/"
    replacement = f"{new_rel}/"

    for jsonl_name in _JSONL_NAMES:
        jsonl_path = task_dir / jsonl_name
        if not jsonl_path.is_file():
            continue
        try:
            lines = jsonl_path.read_text(encoding="utf-8").splitlines(keepends=True)
        except (OSError, UnicodeDecodeError):
            continue

        changed: list[int] = []
        for index, line in enumerate(lines):
            if needle in line:
                lines[index] = line.replace(needle, replacement)
                changed.append(index + 1)
        if changed:
            rewrites.append((jsonl_path, changed, "".join(lines)))

    return rewrites


def _plan_backrefs(
    tasks_dir: Path, task_dir: Path, old_name: str, new_name: str
) -> tuple[list[tuple[Path, dict, list[str]]], list[Path]]:
    """Plan back-reference rewrites in the other active tasks.

    Returns ``(changes, unreadable)``. ``subtasks`` is the legacy spelling of
    ``children`` and is still carried in older task.json files, so both lists
    are rewritten.
    """
    changes: list[tuple[Path, dict, list[str]]] = []
    unreadable: list[Path] = []

    for candidate in sorted(tasks_dir.iterdir()):
        if not candidate.is_dir() or candidate.name == DIR_ARCHIVE:
            continue
        if candidate == task_dir:
            continue
        json_path = candidate / FILE_TASK_JSON
        if not json_path.is_file():
            continue

        data, _reason = read_json_checked(json_path)
        if data is None:
            unreadable.append(json_path)
            continue

        labels: list[str] = []
        if data.get("parent") == old_name:
            data["parent"] = new_name
            labels.append("parent")
        for list_field in ("children", "subtasks"):
            values = data.get(list_field)
            if not isinstance(values, list):
                continue
            for index, value in enumerate(values):
                if value == old_name:
                    values[index] = new_name
                    labels.append(f"{list_field}[{index}]")

        if labels:
            changes.append((json_path, data, labels))

    return changes, unreadable


def _plan_reported_refs(
    repo_root: Path, task_dir: Path, rewritten: set[Path], old_name: str
) -> list[tuple[Path, int]]:
    """Find remaining mentions of the old task name elsewhere under .trellis/.

    These are reported, never rewritten: journal entries and workflow prose
    cite tasks in free text, and a blind substitution there is how a rename
    turns into a diff nobody asked for. The boundary-anchored pattern keeps a
    longer task name that merely contains this one out.

    Runtime session pointers are excluded because they are not prose and they
    *are* rewritten — see ``repoint_task_in_sessions``. Listing them here as
    "not rewritten" would be a false statement about the one file whose
    staleness actually breaks the next command.
    """
    from .active_task import _runtime_sessions_dir

    pattern = re.compile(
        r"(?<![0-9A-Za-z_-])" + re.escape(old_name) + r"(?![0-9A-Za-z_-])"
    )
    hits: list[tuple[Path, int]] = []
    trellis_dir = repo_root / DIR_WORKFLOW
    sessions_dir = _runtime_sessions_dir(repo_root)
    if not trellis_dir.is_dir():
        return hits

    for path in sorted(trellis_dir.rglob("*")):
        if not path.is_file() or path in rewritten:
            continue
        if path == task_dir or task_dir in path.parents:
            continue
        if path.parent == sessions_dir:
            continue
        if any(
            part == "__pycache__" or part.startswith(".backup-")
            for part in path.relative_to(trellis_dir).parts[:-1]
        ):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if pattern.search(line):
                hits.append((path, lineno))

    return hits


def _render_rename_plan(plan: _RenamePlan, repo_root: Path) -> list[str]:
    """Render the change set. Identical for --dry-run and the real run."""
    lines = [
        f"rename: {plan.old_name} -> {plan.new_name}",
        f"  dir: {plan.old_rel} -> {plan.new_rel}",
    ]
    for field_name, old_value, new_value in plan.identity:
        lines.append(f"  task.json: {field_name}: {old_value} -> {new_value}")
    for json_path, _data, labels in plan.backrefs:
        rel = _repo_relative_path(json_path, repo_root)
        for label in labels:
            lines.append(
                f"  backref: {rel}: {label}: {plan.old_name} -> {plan.new_name}"
            )
    for jsonl_path, linenos, _text in plan.jsonl:
        rel = _repo_relative_path(jsonl_path, repo_root)
        for lineno in linenos:
            lines.append(
                f"  jsonl: {rel}:{lineno}: {plan.old_rel}/ -> {plan.new_rel}/"
            )
    for path, lineno in plan.reported:
        lines.append(
            f"  reported (not rewritten): {_repo_relative_path(path, repo_root)}:{lineno}"
        )
    lines.append(
        f"  sessions: any active-task pointer at {plan.old_rel} is repointed to {plan.new_rel}"
    )
    return lines


def _rename_interrupted(plan: _RenamePlan) -> None:
    """Explain how to finish a rename that stopped part-way through."""
    print(
        f"The task is still at {plan.old_rel} and was NOT moved. Every step up to "
        f"this one is idempotent: fix the write failure, then run the same rename "
        f"again to finish it.",
        file=sys.stderr,
    )


def _apply_rename(plan: _RenamePlan, repo_root: Path) -> int:
    """Write the planned change set.

    The directory move goes last on purpose. Everything before it is an
    in-place edit that re-running the identical command recomputes as
    already-done, so an interruption leaves a tree that the same command
    finishes; a move-first ordering would instead leave the old name
    unresolvable and the remaining edits to be made by hand.
    """
    if plan.identity:
        data = dict(plan.task_data)
        for field_name, _old_value, new_value in plan.identity:
            data[field_name] = new_value
        if not write_json(plan.task_json_path, data):
            _report_write_failure(plan.task_json_path)
            print("Nothing was renamed.", file=sys.stderr)
            return 1

    for jsonl_path, _linenos, text in plan.jsonl:
        try:
            jsonl_path.write_text(text, encoding="utf-8")
        except OSError as exc:
            print(
                colored(f"Error: Failed to write {jsonl_path}: {exc}", Colors.RED),
                file=sys.stderr,
            )
            _rename_interrupted(plan)
            return 1

    for json_path, data, _labels in plan.backrefs:
        if not write_json(json_path, data):
            _report_write_failure(json_path)
            _rename_interrupted(plan)
            return 1

    try:
        plan.task_dir.rename(plan.new_dir)
    except OSError as exc:
        print(
            colored(f"Error: Failed to move {plan.old_rel} -> {plan.new_rel}: {exc}", Colors.RED),
            file=sys.stderr,
        )
        _rename_interrupted(plan)
        return 1

    # Last, and after the move: a session pointing at the old path would now
    # resolve to a missing directory, so `current` would report the task stale
    # and the context hook would inject nothing until the user ran `start`
    # again. Archive clears these pointers because the task is leaving; rename
    # moves them, because the task is still the one being worked on.
    from .active_task import repoint_task_in_sessions

    repoint_task_in_sessions(str(plan.task_dir), str(plan.new_dir), repo_root)

    return 0


def cmd_rename(args: argparse.Namespace) -> int:
    """Rename a task and every reference to it."""
    repo_root = get_repo_root()
    tasks_dir = get_tasks_dir(repo_root)

    task_dir = resolve_task_dir(args.name, repo_root)
    if task_dir is None or not task_dir.is_dir():
        if task_dir is not None:
            print(colored(f"Error: Task not found: {args.name}", Colors.RED), file=sys.stderr)
        return 1

    # Narrower than resolve_task_dir's containment: an archived task has left
    # the active set, so its back-references are no longer maintained here.
    if not is_within_tasks_dir(task_dir, repo_root):
        print(
            colored(
                f"Error: refusing to rename '{args.name}': "
                f"{task_dir} is not an active task under {tasks_dir}",
                Colors.RED,
            ),
            file=sys.stderr,
        )
        return 1

    old_name = task_dir.name
    date_prefix, _old_slug = _split_date_prefix(old_name)

    slug = _validate_rename_slug(args.new_slug, date_prefix)
    if slug is None:
        return 1

    new_name = f"{date_prefix}-{slug}" if date_prefix else slug
    if new_name == old_name:
        print(
            colored(f"Error: '{new_name}' is the task's current name", Colors.RED),
            file=sys.stderr,
        )
        return 1

    new_dir = task_dir.parent / new_name
    if new_dir.exists():
        print(
            colored(f"Error: Task already exists: {new_name}", Colors.RED),
            file=sys.stderr,
        )
        print(f"Existing task at: {_repo_relative_path(new_dir, repo_root)}", file=sys.stderr)
        print("Pick a different slug.", file=sys.stderr)
        return 1

    archived_task_dir = _find_archived_task_by_dir_name(tasks_dir, new_name)
    if archived_task_dir:
        print(
            colored(f"Error: Task already archived: {new_name}", Colors.RED),
            file=sys.stderr,
        )
        print(f"Archived at: {_repo_relative_path(archived_task_dir, repo_root)}", file=sys.stderr)
        print("Pick a different slug.", file=sys.stderr)
        return 1

    task_json_path = task_dir / FILE_TASK_JSON
    if not task_json_path.is_file():
        print(
            colored(f"Error: task.json not found at {task_dir}", Colors.RED),
            file=sys.stderr,
        )
        return 1

    task_data, reason = read_json_checked(task_json_path)
    if task_data is None:
        _report_read_failure(task_json_path, reason)
        print("Nothing was renamed.", file=sys.stderr)
        return 1

    plan = _RenamePlan(
        task_dir=task_dir,
        new_dir=new_dir,
        old_name=old_name,
        new_name=new_name,
        old_rel=_repo_relative_path(task_dir, repo_root),
        new_rel=_repo_relative_path(new_dir, repo_root),
        task_json_path=task_json_path,
        task_data=task_data,
    )
    plan.identity = [
        (name, task_data.get(name), slug)
        for name in RENAME_IDENTITY_FIELDS
        if task_data.get(name) != slug
    ]
    plan.jsonl = _plan_jsonl_rewrites(task_dir, plan.old_rel, plan.new_rel)
    plan.backrefs, plan.unreadable = _plan_backrefs(
        tasks_dir, task_dir, old_name, new_name
    )
    rewritten = {path for path, _linenos, _text in plan.jsonl}
    rewritten.update(path for path, _data, _labels in plan.backrefs)
    plan.reported = _plan_reported_refs(repo_root, task_dir, rewritten, old_name)

    for line in _render_rename_plan(plan, repo_root):
        print(line)

    for json_path in plan.unreadable:
        print(
            colored(
                f"Warning: {_repo_relative_path(json_path, repo_root)} could not be read; "
                "any back-reference in it is left as-is.",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )

    if getattr(args, "dry_run", False):
        print(colored("Dry run: nothing was written.", Colors.YELLOW), file=sys.stderr)
        return 0

    rc = _apply_rename(plan, repo_root)
    if rc != 0:
        return rc

    print(colored(f"Renamed: {old_name} -> {new_name}", Colors.GREEN), file=sys.stderr)
    if plan.reported:
        print(
            colored(
                f"{len(plan.reported)} reference(s) elsewhere under {DIR_WORKFLOW}/ "
                "still name the old task; they are listed above and were not rewritten.",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )
    return 0
