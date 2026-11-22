"""Path lookup and error reporting shared by task store and rename commands."""

from __future__ import annotations

import sys
from pathlib import Path

from .io import describe_json_read_failure
from .log import Colors, colored
from .paths import DIR_ARCHIVE


def _find_archived_task_by_dir_name(tasks_dir: Path, dir_name: str) -> Path | None:
    """Find an archived task directory with the exact active-task dir name."""
    archive_dir = tasks_dir / DIR_ARCHIVE
    if not archive_dir.is_dir():
        return None

    for month_dir in sorted(archive_dir.iterdir()):
        if not month_dir.is_dir():
            continue
        candidate = month_dir / dir_name
        if candidate.is_dir():
            return candidate

    return None


def _repo_relative_path(path: Path, repo_root: Path) -> str:
    """Format a path relative to the repo root when possible."""
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return str(path)


def _report_read_failure(path: Path, reason: str | None) -> None:
    """Print why a JSON file could not be loaded, and what to do about it.

    These commands are about to rewrite the file they just failed to read, so
    this message is the last warning the user gets. Exiting non-zero with no
    output at all leaves a parse error, a permissions error and an empty file
    indistinguishable.
    """
    problem, hint = describe_json_read_failure(path, reason)
    print(colored(f"Error: {problem}", Colors.RED), file=sys.stderr)
    print(hint, file=sys.stderr)


def _report_write_failure(path: Path) -> None:
    """Print that a JSON write failed. Writes are atomic, so nothing changed."""
    print(colored(f"Error: Failed to write {path}", Colors.RED), file=sys.stderr)
    print(
        "The existing file is unchanged (writes are atomic). "
        "Check permissions and free disk space, then retry.",
        file=sys.stderr,
    )
