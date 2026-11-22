import fs from "node:fs";
import path from "node:path";
import { FILE_NAMES, PATHS } from "../constants/paths.js";
import {
  sanitizePkgName,
  type DetectedPackage,
  type ProjectType,
} from "../utils/project-detector.js";
import { emptyTaskJson, type TaskJson } from "../utils/task-json.js";

// =============================================================================
// Bootstrap Task Creation
// =============================================================================

const BOOTSTRAP_TASK_NAME = "00-bootstrap-guidelines";

/**
 * Slugify a developer name for safe use in task directory names.
 *
 * Unlike `sanitizePkgName` (which only strips npm @scope/ prefixes), this
 * handles arbitrary developer input: spaces, Unicode letters, punctuation,
 * path separators. Returns "user" fallback when input slugifies to empty.
 *
 * Exported for unit testing; not part of the public API.
 */
export function slugifyDeveloperName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "user";
}

/**
 * Write a task skeleton (task.json + prd.md).
 *
 * Idempotent: if the task dir already exists, returns true without touching
 * anything. Shared by both creator bootstrap and joiner onboarding flows.
 */
function writeTaskSkeleton(
  cwd: string,
  taskName: string,
  taskJson: TaskJson,
  prdContent: string,
): boolean {
  const taskDir = path.join(cwd, PATHS.TASKS, taskName);
  if (fs.existsSync(taskDir)) return true; // idempotent

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, FILE_NAMES.TASK_JSON),
      JSON.stringify(taskJson, null, 2),
      "utf-8",
    );
    fs.writeFileSync(path.join(taskDir, FILE_NAMES.PRD), prdContent, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the bootstrap checklist items (previously stored as structured
 * `subtasks: [{name, status}]` in task.json). Per task 04-21-task-schema-unify
 * (D1), these live as markdown `- [ ]` items in prd.md instead, so task.json
 * stays canonical with `subtasks: string[]` (child task dir names, same as
 * task_store.py).
 */
function getBootstrapChecklistItems(
  projectType: ProjectType,
  packages?: DetectedPackage[],
): string[] {
  if (packages && packages.length > 0) {
    const items = packages.map((pkg) => `Fill guidelines for ${pkg.name}`);
    items.push("Add code examples");
    return items;
  }
  if (projectType === "frontend") {
    return ["Fill frontend guidelines", "Add code examples"];
  }
  if (projectType === "backend") {
    return ["Fill backend guidelines", "Add code examples"];
  }
  return [
    "Fill backend guidelines",
    "Fill frontend guidelines",
    "Add code examples",
  ];
}

function getBootstrapRelatedFiles(
  projectType: ProjectType,
  packages?: DetectedPackage[],
): string[] {
  if (packages && packages.length > 0) {
    return packages.map((pkg) => `.trellis/spec/${sanitizePkgName(pkg.name)}/`);
  }
  if (projectType === "frontend") {
    return [".trellis/spec/frontend/"];
  }
  if (projectType === "backend") {
    return [".trellis/spec/backend/"];
  }
  return [".trellis/spec/backend/", ".trellis/spec/frontend/"];
}

function getBootstrapPrdContent(
  projectType: ProjectType,
  pythonCmd: string,
  packages?: DetectedPackage[],
): string {
  const checklistItems = getBootstrapChecklistItems(projectType, packages);
  const checklistMarkdown = checklistItems
    .map((item) => `- [ ] ${item}`)
    .join("\n");

  const header = `# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran \`trellis init\` on this project for the first time.
\`.trellis/\` now exists with empty spec scaffolding, and this bootstrap task
exists under \`.trellis/tasks/\`. When they want to work on it, they should start
this task from a session that provides Trellis session identity.

**Your job**: help them populate \`.trellis/spec/\` with the team's real
coding conventions. Every future AI session — this project's
\`trellis-implement\` and \`trellis-check\` sub-agents — auto-loads spec files
listed in per-task jsonl manifests. Empty spec = sub-agents write generic
code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out if the repo
has any existing convention docs (CLAUDE.md, .cursorrules, etc.), and drive
the rest conversationally.

---

## Status (update the checkboxes as you complete each item)

${checklistMarkdown}

---

## Spec files to populate
`;

  const backendSection = `

### Backend guidelines

| File | What to document |
|------|------------------|
| \`.trellis/spec/backend/directory-structure.md\` | Where different file types go (routes, services, utils) |
| \`.trellis/spec/backend/database-guidelines.md\` | ORM, migrations, query patterns, naming conventions |
| \`.trellis/spec/backend/error-handling.md\` | How errors are caught, logged, and returned |
| \`.trellis/spec/backend/logging-guidelines.md\` | Log levels, format, what to log |
| \`.trellis/spec/backend/quality-guidelines.md\` | Code review standards, testing requirements |
`;

  const frontendSection = `

### Frontend guidelines

| File | What to document |
|------|------------------|
| \`.trellis/spec/frontend/directory-structure.md\` | Component/page/hook organization |
| \`.trellis/spec/frontend/component-guidelines.md\` | Component patterns, props conventions |
| \`.trellis/spec/frontend/hook-guidelines.md\` | Custom hook naming, patterns |
| \`.trellis/spec/frontend/state-management.md\` | State library, patterns, what goes where |
| \`.trellis/spec/frontend/type-safety.md\` | TypeScript conventions, type organization |
| \`.trellis/spec/frontend/quality-guidelines.md\` | Linting, testing, accessibility |
`;

  const footer = `

### Thinking guides (already populated)

\`.trellis/spec/guides/\` contains general thinking guides pre-filled with
best practices. Customize only if something clearly doesn't fit this project.

---

## How to fill the spec

### Step 1: Import from existing convention files first (preferred)

Search the repo for existing convention docs. If any exist, read them and
extract the relevant rules into the matching \`.trellis/spec/\` files —
usually much faster than documenting from scratch.

| File / Directory | Tool |
|------|------|
| \`CLAUDE.md\` / \`CLAUDE.local.md\` | Claude Code |
| \`AGENTS.md\` | Codex / Claude Code / agent-compatible tools |
| \`.cursorrules\` | Cursor |
| \`.cursor/rules/*.mdc\` | Cursor (rules directory) |
| \`.windsurfrules\` | Windsurf |
| \`.clinerules\` | Cline |
| \`.roomodes\` | Roo Code |
| \`.github/copilot-instructions.md\` | GitHub Copilot |
| \`.vscode/settings.json\` → \`github.copilot.chat.codeGeneration.instructions\` | VS Code Copilot |
| \`CONVENTIONS.md\` / \`.aider.conf.yml\` | aider |
| \`CONTRIBUTING.md\` | General project conventions |
| \`.editorconfig\` | Editor formatting rules |

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:
- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths (not hypothetical ones).
- Document anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do.
Sub-agents match the spec, so aspirational patterns that don't exist in the
codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state — improvement
is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: \`trellis-implement\` (writes
  code) and \`trellis-check\` (verifies quality).
- Each task has \`implement.jsonl\` / \`check.jsonl\` manifests listing which
  spec files to load.
- The platform hook auto-injects those spec files + the task's \`prd.md\`
  into every sub-agent prompt, so the sub-agent codes/reviews per team
  conventions without anyone pasting them manually.
- Source of truth: \`.trellis/spec/\`. That's why filling it well now pays
  off forever.

---

## Completion

When the developer confirms the checklist items above are done with real
examples (not placeholders), guide them to run:

\`\`\`bash
${pythonCmd} ./.trellis/scripts/task.py finish
${pythonCmd} ./.trellis/scripts/task.py archive 00-bootstrap-guidelines
\`\`\`

After archive, every new developer who joins this project will get a
\`00-join-<slug>\` onboarding task instead of this bootstrap task.

---

## Suggested opening line

"Welcome to Trellis! Your init just set me up to help you fill the project
spec — a one-time setup so every future AI session follows the team's
conventions instead of writing generic code. Before we start, do you have
any existing convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md,
etc.) I can pull from, or should I scan the codebase from scratch?"
`;

  let content = header;

  if (packages && packages.length > 0) {
    // Monorepo: generate per-package sections
    for (const pkg of packages) {
      const pkgType = pkg.type === "unknown" ? "fullstack" : pkg.type;
      const specName = sanitizePkgName(pkg.name);
      content += `\n### Package: ${pkg.name} (\`spec/${specName}/\`)\n`;
      if (pkgType !== "frontend") {
        content += `\n- Backend guidelines: \`.trellis/spec/${specName}/backend/\`\n`;
      }
      if (pkgType !== "backend") {
        content += `\n- Frontend guidelines: \`.trellis/spec/${specName}/frontend/\`\n`;
      }
    }
  } else if (projectType === "frontend") {
    content += frontendSection;
  } else if (projectType === "backend") {
    content += backendSection;
  } else {
    // fullstack
    content += backendSection;
    content += frontendSection;
  }
  content += footer;

  return content;
}

function getBootstrapTaskJson(
  developer: string,
  projectType: ProjectType,
  packages?: DetectedPackage[],
): TaskJson {
  const today = new Date().toISOString().split("T")[0];
  const relatedFiles = getBootstrapRelatedFiles(projectType, packages);

  // Canonical 24-field shape via emptyTaskJson factory.
  // Checklist items (previously stored as structured `subtasks`) are now
  // rendered as `- [ ]` items in prd.md; task.json.subtasks is always
  // string[] (child task dir names) per the canonical schema.
  return emptyTaskJson({
    id: BOOTSTRAP_TASK_NAME,
    name: BOOTSTRAP_TASK_NAME,
    title: "Bootstrap Guidelines",
    description: "Fill in project development guidelines for AI agents",
    status: "in_progress",
    dev_type: "docs",
    priority: "P1",
    creator: developer,
    assignee: developer,
    createdAt: today,
    relatedFiles,
    notes: `First-time setup task created by trellis init (${projectType} project)`,
  });
}

/**
 * Create bootstrap task for first-time setup
 */
export function createBootstrapTask(
  cwd: string,
  developer: string,
  pythonCmd: string,
  projectType: ProjectType,
  packages?: DetectedPackage[],
): boolean {
  const taskJson = getBootstrapTaskJson(developer, projectType, packages);
  const prdContent = getBootstrapPrdContent(projectType, pythonCmd, packages);
  return writeTaskSkeleton(cwd, BOOTSTRAP_TASK_NAME, taskJson, prdContent);
}

// =============================================================================
// Joiner Onboarding Task Creation
// =============================================================================

/**
 * task.json factory for joiner onboarding. Mirrors the bootstrap factory but
 * uses dev_type "docs", higher priority "P1", and the developer-specific task
 * name (so multiple joiners in the same checkout don't collide).
 */
function getJoinerTaskJson(developer: string, taskName: string): TaskJson {
  const today = new Date().toISOString().split("T")[0];
  return emptyTaskJson({
    id: taskName,
    name: taskName,
    title: `Joining: Onboard to this Trellis project (${developer})`,
    description:
      "Onboard a new developer to an existing Trellis project: learn the workflow, conventions, and find assigned work",
    status: "in_progress",
    dev_type: "docs",
    priority: "P1",
    creator: developer,
    assignee: developer,
    createdAt: today,
    notes:
      "Generated by trellis init for a new developer joining an existing Trellis project",
  });
}

/**
 * PRD content for joiner onboarding. Kept concise (~80 lines) — deeper
 * guidance lives in skills and docs.
 */
function getJoinerPrdContent(developer: string, pythonCmd: string): string {
  const slug = slugifyDeveloperName(developer);
  return `# Joiner Onboarding Task

**You (the AI) are running this task. The developer does not read this file.**

\`${developer}\` just ran \`trellis init\` on a fresh clone, saw "Developer
initialized", and will now start asking you questions in chat. This joiner task
exists under \`.trellis/tasks/\`; when they want to work on it, they should
start it from a session that provides Trellis session identity.

Your job is to orient them to Trellis. Don't dump all of this at them — open
with a short greeting, ask where they want to start, and fill in the rest as
they engage.

---

## Topics to cover (adapt order to their questions)

### 1. What Trellis is + the workflow

Trellis is a workflow layer over Claude Code / Cursor / etc. that keeps AI
agents consistent with project-specific conventions instead of writing generic
code every session.

- **Three phases**: Plan (brainstorm → \`prd.md\`) → Execute (code + check) →
  Finish (capture + wrap). Full reference: \`.trellis/workflow.md\`.
- **Task lifecycle**: planning → in_progress → done → archive, under
  \`.trellis/tasks/\`.
- **Core slash commands**:
  - \`/trellis:continue\` — resume the current session's active task
  - \`/trellis:finish-work\` — wrap up a finished task
  - \`/trellis:start\` — session boot from scratch (not needed here; the
    SessionStart hook does its job automatically)

### 2. Runtime mechanics (explain when they ask "how does it know what to do")

- **SessionStart hook** runs \`get_context.py\` and injects identity, git
  status, session active task, active tasks, and workflow phase into the AI
  conversation at every session start.
- **\`<workflow-state>\` tag** is auto-injected with every user message,
  carrying the current task + phase hint.
- **\`/trellis:continue\`** loads the Phase Index, reads \`prd.md\` + recent
  activity, and routes to the right skill (\`trellis-brainstorm\` for planning,
  \`trellis-implement\` for coding, \`trellis-check\` for verification).
- **\`trellis-implement\` sub-agent** is spawned when code needs to be written.
  The platform hook reads \`{TASK_DIR}/implement.jsonl\` and auto-injects those
  spec files + \`prd.md\` into the sub-agent's prompt so it codes per project
  conventions.
- **\`trellis-check\` sub-agent** follows the same pattern with \`check.jsonl\`
  — reviews changes against specs, auto-fixes issues, runs lint/typecheck.

File layout (mention when they ask "where does what live"):
- \`.trellis/.runtime/sessions/<session>.json\` — session active-task state, gitignored
- \`.trellis/tasks/<task>/{implement,check}.jsonl\` — per-task context manifests
- \`.trellis/spec/\` — project-wide conventions (source of truth)
- \`.trellis/workspace/${developer}/journal-*.md\` — their session log,
  rotated at ~2000 lines

### 3. This project's actual conventions

- Summarize \`.trellis/spec/\` for them — what coding conventions this
  specific team enforces.
- Point at the last 5 entries in \`.trellis/tasks/archive/\` as a rhythm
  example of how people actually work here. **If archive is empty** (the
  project just started), skip this — don't invent examples.
- Not your job in this onboarding to teach them the business code itself —
  the README and their teammates handle that.

### 4. Their assigned work

- Check if \`.trellis/workspace/${developer}/\` already exists — if yes, it's
  their journal from another machine and worth mentioning.
- Run \`${pythonCmd} ./.trellis/scripts/task.py list --mine\` to show tasks assigned to them.
- Remind them that the "My Tasks" section appears in the SessionStart context
  on every new session.

---

## Optional: walk through a small task end-to-end

If they want to practice before touching real work, offer to pick a tiny
P3 task or a typo fix and run the full cycle together: \`/trellis:continue\`
→ you implement via sub-agents → \`/trellis:finish-work\`.

---

## Completion

When they feel oriented (or after you've covered the four topics with
reasonable back-and-forth), guide them to run:

\`\`\`bash
${pythonCmd} ./.trellis/scripts/task.py finish
${pythonCmd} ./.trellis/scripts/task.py archive 00-join-${slug}
\`\`\`

---

## Suggested opening line

"Welcome! Your \`trellis init\` set me up to onboard you to this project. I
can walk you through the workflow, show you the runtime mechanics under the
hood, summarize the team's spec, or jump to what you're already curious about
— which would you prefer?"
`;
}

/**
 * Create joiner onboarding task for a new developer on an existing Trellis
 * project. Task name is slugified to be filesystem-safe for arbitrary
 * developer names (spaces, Unicode, punctuation).
 */
export function createJoinerOnboardingTask(
  cwd: string,
  developer: string,
  pythonCmd: string,
): boolean {
  const slug = slugifyDeveloperName(developer);
  const taskName = `00-join-${slug}`;
  const taskJson = getJoinerTaskJson(developer, taskName);
  const prdContent = getJoinerPrdContent(developer, pythonCmd);
  return writeTaskSkeleton(cwd, taskName, taskJson, prdContent);
}
