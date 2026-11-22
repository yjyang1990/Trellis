import type { MigrationItem } from "../types/migration.js";

// The private skill files shipped before Windsurf 0.6.3 and Pi 0.6.8 had
// identical names. Freeze those names: future shared skills (including
// Codex-only commands) cannot establish ownership in a retired directory.
const privateSkillFiles = [
  "trellis-before-dev/SKILL.md",
  "trellis-brainstorm/SKILL.md",
  "trellis-break-loop/SKILL.md",
  "trellis-channel/SKILL.md",
  "trellis-channel/references/command-reference.md",
  "trellis-channel/references/forum.md",
  "trellis-channel/references/progress-debugging.md",
  "trellis-channel/references/workers.md",
  "trellis-channel/references/workflows.md",
  "trellis-check/SKILL.md",
  "trellis-meta/SKILL.md",
  "trellis-meta/references/customize-local/add-project-local-conventions.md",
  "trellis-meta/references/customize-local/change-agents.md",
  "trellis-meta/references/customize-local/change-context-loading.md",
  "trellis-meta/references/customize-local/change-hooks.md",
  "trellis-meta/references/customize-local/change-skills-or-commands.md",
  "trellis-meta/references/customize-local/change-spec-structure.md",
  "trellis-meta/references/customize-local/change-task-lifecycle.md",
  "trellis-meta/references/customize-local/change-workflow.md",
  "trellis-meta/references/customize-local/overview.md",
  "trellis-meta/references/local-architecture/bundled-skills.md",
  "trellis-meta/references/local-architecture/context-injection.md",
  "trellis-meta/references/local-architecture/generated-files.md",
  "trellis-meta/references/local-architecture/multi-agent-channel.md",
  "trellis-meta/references/local-architecture/overview.md",
  "trellis-meta/references/local-architecture/spec-system.md",
  "trellis-meta/references/local-architecture/task-system.md",
  "trellis-meta/references/local-architecture/workflow.md",
  "trellis-meta/references/local-architecture/workspace-memory.md",
  "trellis-meta/references/platform-files/agents.md",
  "trellis-meta/references/platform-files/hooks-and-settings.md",
  "trellis-meta/references/platform-files/overview.md",
  "trellis-meta/references/platform-files/platform-map.md",
  "trellis-meta/references/platform-files/skills-and-commands.md",
  "trellis-session-insight/SKILL.md",
  "trellis-session-insight/references/cli-quick-reference.md",
  "trellis-session-insight/references/triggering-patterns.md",
  "trellis-spec-bootstrap/SKILL.md",
  "trellis-spec-bootstrap/references/mcp-setup.md",
  "trellis-spec-bootstrap/references/repository-analysis.md",
  "trellis-spec-bootstrap/references/spec-task-planning.md",
  "trellis-spec-bootstrap/references/spec-writing.md",
  "trellis-update-spec/SKILL.md",
];

const legacyDirectoryFiles: Record<string, readonly string[]> = {
  ".kilocode/commands/trellis": [
    "before-backend-dev.md",
    "before-frontend-dev.md",
    "brainstorm.md",
    "break-loop.md",
    "check-backend.md",
    "check-cross-layer.md",
    "check-frontend.md",
    "create-command.md",
    "finish-work.md",
    "integrate-skill.md",
    "onboard.md",
    "parallel.md",
    "record-session.md",
    "start.md",
    "update-spec.md",
  ],
  ".windsurf/skills": privateSkillFiles,
  ".pi/skills": privateSkillFiles,
  ".windsurf/workflows": [
    "trellis-start.md",
    "trellis-continue.md",
    "trellis-finish-work.md",
  ],
  ".zcode/cli/agents": ["trellis-check.md", "trellis-implement.md"],
};

/** Exact legacy file paths that may keep an existing installation receipt. */
export function legacyRenameSourceFiles(
  migrations: MigrationItem[],
): Set<string> {
  const paths = new Set<string>();
  for (const migration of migrations) {
    if (migration.type !== "rename-dir") continue;
    // The 0.6.0-beta.23 spelling correction shipped the same bundled skill
    // across multiple platform roots.
    if (migration.from.endsWith("/trellis-spec-bootstarp")) {
      for (const file of privateSkillFiles) {
        if (file.startsWith("trellis-spec-bootstrap/")) {
          paths.add(
            `${migration.from}/${file.slice("trellis-spec-bootstrap/".length)}`,
          );
        }
      }
    }
    for (const file of legacyDirectoryFiles[migration.from] ?? []) {
      paths.add(`${migration.from}/${file}`);
    }
  }
  return paths;
}
