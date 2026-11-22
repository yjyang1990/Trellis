import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";

import { DIR_NAMES } from "../constants/paths.js";
import type {
  ClassifiedMigrations,
  MigrationAction,
  MigrationItem,
  MigrationResult,
  TemplateHashes,
} from "../types/migration.js";
import { cleanupEmptyDirs } from "../utils/managed-paths.js";
import {
  computeHash,
  isTemplateModified,
  loadHashes,
  removeHash,
  renameHash,
  saveHashes,
} from "../utils/template-hash.js";
import { legacyRenameSourceFiles } from "./legacy-directory-files.js";

// Paths that should never be touched (true user data)
// spec/ is user-customized content created during init; update should never modify it
export const PROTECTED_PATHS = [
  `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.WORKSPACE}`, // workspace/
  `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.TASKS}`, // tasks/
  `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SPEC}`, // spec/
  `${DIR_NAMES.WORKFLOW}/.developer`,
  `${DIR_NAMES.WORKFLOW}/.current-task`,
];

/**
 * Check if a path is blocked by PROTECTED_PATHS
 */
export function isProtectedPath(filePath: string): boolean {
  return PROTECTED_PATHS.some(
    (pp) =>
      filePath === pp || filePath.startsWith(pp.endsWith("/") ? pp : pp + "/"),
  );
}

/** Check existing parents before a move. A regular file blocks the path, and
 * a link would cause the migration to operate outside the inspected tree. */
function hasDirectoryParents(cwd: string, relativePath: string): boolean {
  let parent = cwd;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    parent = path.join(parent, segment);
    const entry = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!entry) return true;
    if (!entry.isDirectory()) return false;
  }
  return true;
}

/** Check every entry, including backup-excluded trees. Links and special files
 * cannot be established as regular installed template files. */
function directoryFilesMatch(
  cwd: string,
  dir: string,
  matches: (file: string) => boolean,
): boolean {
  const entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true });
  return entries.every((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return directoryFilesMatch(cwd, file, matches);
    return entry.isFile() && matches(file);
  });
}

/** When both roots exist, retain the destination (including target-only
 * files). Only retire installed, unmodified source files with counterparts. */
function isRedundantMigrationSource(
  cwd: string,
  from: string,
  to: string,
  hashes: TemplateHashes,
  templates: Map<string, string>,
  legacyFiles: ReadonlySet<string>,
): boolean {
  return (
    directoryFilesMatch(cwd, to, (file) => {
      const content = fs.readFileSync(path.join(cwd, file), "utf8");
      return (
        templates.get(file) === content || hashes[file] === computeHash(content)
      );
    }) &&
    directoryFilesMatch(cwd, from, (file) => {
      const target = to + file.slice(from.length);
      return (
        legacyFiles.has(file) &&
        templates.has(target) &&
        hasDirectoryParents(cwd, target) &&
        fs
          .lstatSync(path.join(cwd, target), { throwIfNoEntry: false })
          ?.isFile() === true &&
        !isTemplateModified(cwd, file, hashes)
      );
    })
  );
}

/**
 * Recursively delete a directory
 */
function removeDirectoryRecursive(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Check if a file is safe to overwrite (matches template content)
 */
function isFileSafeToReplace(
  cwd: string,
  relativePath: string,
  templates: Map<string, string>,
): boolean {
  const fullPath = path.join(cwd, relativePath);
  if (!fs.existsSync(fullPath)) return true;

  const templateContent = templates.get(relativePath);
  if (!templateContent) return false; // Not a template file

  const currentContent = fs.readFileSync(fullPath, "utf-8");
  return currentContent === templateContent;
}

/** A receipt for a missing file cannot establish ownership of a newly
 * created directory at the same path. The old .trellis roots are walk-managed
 * and may only use that broader evidence for a lossless move. */
export function dirHasManifestEntries(
  cwd: string,
  from: string,
  hashes: TemplateHashes,
  legacyFiles: ReadonlySet<string>,
  targetExists: boolean,
): boolean {
  const prefix = `${from}/`;
  return Object.keys(hashes).some(
    (file) =>
      file.startsWith(prefix) &&
      (legacyFiles.has(file) ||
        (!targetExists && from.startsWith(".trellis/"))) &&
      hasDirectoryParents(cwd, file) &&
      fs.lstatSync(path.join(cwd, file), { throwIfNoEntry: false })?.isFile(),
  );
}

export function classifyMigrations(
  migrations: MigrationItem[],
  cwd: string,
  hashes: TemplateHashes,
  templates: Map<string, string>,
): ClassifiedMigrations {
  const result: ClassifiedMigrations = {
    auto: [],
    confirm: [],
    conflict: [],
    skip: [],
  };

  const legacyFiles = legacyRenameSourceFiles(migrations);
  for (const item of migrations) {
    // safe-file-delete handled separately (not via --migrate)
    if (item.type === "safe-file-delete") continue;

    // Enforce PROTECTED_PATHS — never migrate FROM protected paths (prevents moving/deleting user data)
    if (isProtectedPath(item.from)) {
      result.skip.push(item);
      continue;
    }
    // For non-rename types, also block writing TO protected paths
    // rename/rename-dir are allowed to target protected paths (e.g., 0.2.0 renames into .trellis/workspace)
    if (
      item.to &&
      isProtectedPath(item.to) &&
      item.type !== "rename" &&
      item.type !== "rename-dir"
    ) {
      result.skip.push(item);
      continue;
    }

    const oldPath = path.join(cwd, item.from);
    const oldExists = fs.existsSync(oldPath);

    if (!oldExists) {
      // Old file doesn't exist, nothing to migrate
      result.skip.push(item);
      continue;
    }

    if (item.type === "rename" && item.to) {
      const newPath = path.join(cwd, item.to);
      const newExists = fs.existsSync(newPath);

      if (newExists) {
        // Both exist - check if new file matches template (safe to overwrite)
        if (isFileSafeToReplace(cwd, item.to, templates)) {
          // New file is just template content - safe to delete and rename
          result.auto.push(item);
        } else {
          // New file has user content - conflict
          result.conflict.push(item);
        }
      } else if (isTemplateModified(cwd, item.from, hashes)) {
        // User has modified the file - needs confirmation
        result.confirm.push(item);
      } else {
        // Unmodified template - safe to auto-migrate
        result.auto.push(item);
      }
    } else if (item.type === "rename-dir" && item.to) {
      const newPath = path.join(cwd, item.to);
      if (!hasDirectoryParents(cwd, item.to)) {
        result.conflict.push(item);
        continue;
      }
      const target = fs.lstatSync(newPath, { throwIfNoEntry: false });
      if (
        !fs.lstatSync(oldPath).isDirectory() ||
        !dirHasManifestEntries(cwd, item.from, hashes, legacyFiles, !!target)
      ) {
        result.skip.push(item);
      } else if (
        !target ||
        (target.isDirectory() &&
          isRedundantMigrationSource(
            cwd,
            item.from,
            item.to,
            hashes,
            templates,
            legacyFiles,
          ))
      ) {
        result.auto.push(item);
      } else {
        result.conflict.push(item);
      }
    } else if (item.type === "delete") {
      if (isTemplateModified(cwd, item.from, hashes)) {
        // User has modified - needs confirmation before delete
        result.confirm.push(item);
      } else {
        // Unmodified - safe to auto-delete
        result.auto.push(item);
      }
    }
  }

  return result;
}

/**
 * Print migration summary
 */
export function printMigrationSummary(classified: ClassifiedMigrations): void {
  const total =
    classified.auto.length +
    classified.confirm.length +
    classified.conflict.length +
    classified.skip.length;

  if (total === 0) {
    console.log(chalk.gray("  No migrations to apply.\n"));
    return;
  }

  if (classified.auto.length > 0) {
    console.log(chalk.green("  ✓ Auto-migrate (unmodified):"));
    for (const item of classified.auto) {
      if (item.type === "rename") {
        console.log(chalk.green(`    ${item.from} → ${item.to}`));
      } else if (item.type === "rename-dir") {
        console.log(chalk.green(`    [dir] ${item.from}/ → ${item.to}/`));
      } else {
        console.log(chalk.green(`    ✕ ${item.from}`));
      }
    }
    console.log("");
  }

  if (classified.confirm.length > 0) {
    console.log(chalk.yellow("  ⚠ Requires confirmation (modified by user):"));
    for (const item of classified.confirm) {
      if (item.type === "rename") {
        console.log(chalk.yellow(`    ${item.from} → ${item.to}`));
      } else {
        console.log(chalk.yellow(`    ✕ ${item.from}`));
      }
    }
    console.log("");
  }

  if (classified.conflict.length > 0) {
    console.log(chalk.red("  ⊘ Conflict (both old and new exist):"));
    for (const item of classified.conflict) {
      if (item.type === "rename-dir") {
        console.log(chalk.red(`    [dir] ${item.from}/ ↔ ${item.to}/`));
      } else {
        console.log(chalk.red(`    ${item.from} ↔ ${item.to}`));
      }
    }
    console.log(
      chalk.gray(
        "    → Resolve manually: merge or delete one, then re-run update",
      ),
    );
    console.log("");
  }

  if (classified.skip.length > 0) {
    console.log(
      chalk.gray("  ○ Skipping (not found, protected, or not Trellis-owned):"),
    );
    for (const item of classified.skip.slice(0, 3)) {
      console.log(chalk.gray(`    ${item.from}`));
    }
    if (classified.skip.length > 3) {
      console.log(chalk.gray(`    ... and ${classified.skip.length - 3} more`));
    }
    console.log("");
  }
}

/**
 * Prompt user for migration action on a single item.
 *
 * Design notes:
 * - Default is `backup-rename`: safest — preserves user's content as a .backup
 *   alongside the rename, so Enter-to-continue never destroys work or leaves
 *   stale paths behind.
 * - "Skip" leaves a stale old path that won't be cleaned by later updates —
 *   warn explicitly so users understand the consequence.
 * - Show manifest description + why-flagged so users can make an informed
 *   choice without needing to dig through the diff.
 */
async function promptMigrationAction(
  item: MigrationItem,
): Promise<MigrationAction> {
  const headline =
    item.type === "rename"
      ? `${chalk.cyan(item.from)} → ${chalk.green(item.to)}`
      : `${chalk.red("Delete")} ${chalk.cyan(item.from)}`;

  const description =
    item.description ?? "No description provided in manifest.";

  // Actions with inline guidance so users see the trade-off per choice.
  const renameLabel =
    item.type === "rename"
      ? "[r] Rename anyway — use if the file is unchanged, or any edits are fine to move as-is"
      : "[d] Delete anyway — use if you don't need this file (already migrated to replacement)";
  const backupLabel =
    item.type === "rename"
      ? "[b] Backup original, then proceed — SAFEST: writes <new-path>.backup with your current content, then renames"
      : "[b] Backup original, then proceed — SAFEST: writes <path>.backup with your current content, then deletes";
  const skipLabel =
    item.type === "rename"
      ? "[s] Skip — leaves the old path in place (you'll see it flagged on future updates until cleaned up manually)"
      : "[s] Skip — keeps the deprecated file (you'll see it flagged on future updates until cleaned up manually)";

  // Prefer the per-migration `reason` (version-specific context authored in the
  // manifest) over a generic fallback. Hardcoding version-specific hints here
  // rots fast — every release gets a new set of edge cases.
  const whyFlagged = item.reason
    ? chalk.gray(
        item.reason
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      )
    : chalk.gray(
        `  Why prompted: file content doesn't match the Trellis template hash\n` +
          `  for this path — usually local customization. If unsure, pick [b].`,
      );

  const message = [
    headline,
    "",
    chalk.bold("  What:") + " " + description,
    whyFlagged,
    "",
    chalk.bold("  Choose:"),
  ].join("\n");

  const { choice } = await inquirer.prompt<{ choice: MigrationAction }>([
    {
      type: "list",
      name: "choice",
      message,
      choices: [
        { name: backupLabel, value: "backup-rename" as MigrationAction },
        { name: renameLabel, value: "rename" as MigrationAction },
        { name: skipLabel, value: "skip" as MigrationAction },
      ],
      default: "backup-rename",
    },
  ]);

  return choice;
}

/**
 * Sort migrations for safe execution order
 * - rename-dir with deeper paths first (to handle nested directories)
 * - rename-dir before rename/delete
 */
/** @internal Exported for testing only */
export function sortMigrationsForExecution(
  migrations: MigrationItem[],
): MigrationItem[] {
  return [...migrations].sort((a, b) => {
    // rename-dir should be sorted by path depth (deeper first)
    if (a.type === "rename-dir" && b.type === "rename-dir") {
      const aDepth = a.from.split("/").length;
      const bDepth = b.from.split("/").length;
      return bDepth - aDepth; // Deeper paths first
    }
    // rename-dir before rename/delete (directories first)
    if (a.type === "rename-dir" && b.type !== "rename-dir") return -1;
    if (a.type !== "rename-dir" && b.type === "rename-dir") return 1;
    return 0;
  });
}

/**
 * Execute classified migrations
 *
 * @param options.force - Force migrate modified files without asking
 * @param options.skipAll - Skip all modified files without asking
 * If neither is set, prompts interactively for modified files
 */
export async function executeMigrations(
  classified: ClassifiedMigrations,
  cwd: string,
  options: { force?: boolean; skipAll?: boolean },
  templates: Map<string, string>,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    renamed: 0,
    deleted: 0,
    skipped: 0,
    conflicts: classified.conflict.length,
  };

  // Sort migrations for safe execution order
  const sortedAuto = sortMigrationsForExecution(classified.auto);

  // 1. Execute auto migrations (unmodified files and directories)
  for (const item of sortedAuto) {
    if (item.type === "rename" && item.to) {
      const oldPath = path.join(cwd, item.from);
      const newPath = path.join(cwd, item.to);

      // Ensure target directory exists
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.renameSync(oldPath, newPath);

      // Update hash tracking
      renameHash(cwd, item.from, item.to);

      // Make executable if it's a script
      if (item.to.endsWith(".sh") || item.to.endsWith(".py")) {
        fs.chmodSync(newPath, "755");
      }

      // Clean up empty source directory
      cleanupEmptyDirs(cwd, path.dirname(item.from));

      result.renamed++;
    } else if (item.type === "rename-dir" && item.to) {
      const oldPath = path.join(cwd, item.from);
      const newPath = path.join(cwd, item.to);
      const oldPrefix = item.from.endsWith("/") ? item.from : item.from + "/";
      const newPrefix = item.to.endsWith("/") ? item.to : item.to + "/";

      const hashes = loadHashes(cwd);
      // Earlier, deeper migrations can change this tree after classification.
      if (!classifyMigrations([item], cwd, hashes, templates).auto.length) {
        result.skipped++;
        continue;
      }
      if (fs.existsSync(newPath)) {
        removeDirectoryRecursive(oldPath);
        saveHashes(
          cwd,
          Object.fromEntries(
            Object.entries(hashes).filter(
              ([file]) => !file.startsWith(oldPrefix),
            ),
          ),
        );
        result.deleted++;
        continue;
      }

      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(newPath), { recursive: true });

      // Rename the entire directory (includes all user files)
      fs.renameSync(oldPath, newPath);

      // Batch update hash tracking for all files in the directory
      const updatedHashes: TemplateHashes = {};
      for (const [hashPath, hashValue] of Object.entries(hashes)) {
        if (hashPath.startsWith(oldPrefix)) {
          // Rename path: old prefix -> new prefix
          const newHashPath = newPrefix + hashPath.slice(oldPrefix.length);
          updatedHashes[newHashPath] = hashValue;
        } else if (
          !hashPath.startsWith(newPrefix) ||
          !fs.existsSync(path.join(cwd, hashPath))
        ) {
          // Keep destination-only receipts for files the user deleted.
          updatedHashes[hashPath] = hashValue;
        }
      }
      saveHashes(cwd, updatedHashes);

      result.renamed++;
    } else if (item.type === "delete") {
      const filePath = path.join(cwd, item.from);
      fs.unlinkSync(filePath);

      // Remove from hash tracking
      removeHash(cwd, item.from);

      // Clean up empty directory
      cleanupEmptyDirs(cwd, path.dirname(item.from));

      result.deleted++;
    }
  }

  // 2. Handle confirm items (modified files)
  // Note: All files are already backed up by createMigrationBackup before execution
  for (const item of classified.confirm) {
    let action: MigrationAction;

    if (options.force) {
      // Force mode: proceed (already backed up)
      action = "rename";
    } else if (options.skipAll) {
      // Skip mode: skip all modified files
      action = "skip";
    } else {
      // Default: interactive prompt
      action = await promptMigrationAction(item);
    }

    if (action === "skip") {
      result.skipped++;
      continue;
    }

    // For `backup-rename`, leave an inline .backup copy of the user's modified
    // original next to the new location (for rename) or in place (for delete).
    // This is in addition to the full project snapshot at .trellis/.backup-*/;
    // the inline copy is more discoverable when the user wants to diff or merge
    // their customizations against the new template.
    if (item.type === "rename" && item.to) {
      const oldPath = path.join(cwd, item.from);
      const newPath = path.join(cwd, item.to);

      fs.mkdirSync(path.dirname(newPath), { recursive: true });

      if (action === "backup-rename") {
        // Copy original alongside the new path before the rename overwrites nothing
        // (target dir is guaranteed fresh since `conflict` is handled elsewhere).
        fs.copyFileSync(oldPath, newPath + ".backup");
      }

      fs.renameSync(oldPath, newPath);
      renameHash(cwd, item.from, item.to);

      if (item.to.endsWith(".sh") || item.to.endsWith(".py")) {
        fs.chmodSync(newPath, "755");
      }

      // Clean up empty source directory
      cleanupEmptyDirs(cwd, path.dirname(item.from));

      result.renamed++;
    } else if (item.type === "delete") {
      const filePath = path.join(cwd, item.from);

      if (action === "backup-rename") {
        // Keep a .backup copy in place before deletion so the user can recover
        // inline without digging through .trellis/.backup-*/.
        fs.copyFileSync(filePath, filePath + ".backup");
      }

      fs.unlinkSync(filePath);
      removeHash(cwd, item.from);

      // Clean up empty directory
      cleanupEmptyDirs(cwd, path.dirname(item.from));

      result.deleted++;
    }
  }

  // 3. Skip count already tracked (old files not found)
  result.skipped += classified.skip.length;

  return result;
}

/**
 * Print migration result summary
 */
export function printMigrationResult(result: MigrationResult): void {
  const parts: string[] = [];

  if (result.renamed > 0) {
    parts.push(`${result.renamed} renamed`);
  }
  if (result.deleted > 0) {
    parts.push(`${result.deleted} deleted`);
  }
  if (result.skipped > 0) {
    parts.push(`${result.skipped} skipped`);
  }
  if (result.conflicts > 0) {
    parts.push(
      `${result.conflicts} conflict${result.conflicts > 1 ? "s" : ""}`,
    );
  }

  if (parts.length > 0) {
    console.log(chalk.cyan(`Migration complete: ${parts.join(", ")}`));
  }
}

/**
 * One-time 0.2.0 migration: rename `traces-*.md` → `journal-*.md` in every
 * developer workspace directory.
 *
 * Never overwrites an existing `journal-N.md`: a newer session may already
 * have created it, and `.trellis/workspace/` is excluded from the update
 * backup (see `BACKUP_EXCLUDE_PATTERNS`), so clobbering it would be
 * unrecoverable data loss. Conflicting `traces-N.md` files are left in place
 * and reported instead.
 */
export function renameTracesToJournal(workspaceDir: string): {
  renamed: number;
  skipped: string[];
} {
  const skipped: string[] = [];
  let renamed = 0;
  if (!fs.existsSync(workspaceDir)) return { renamed, skipped };

  for (const dev of fs.readdirSync(workspaceDir)) {
    const devPath = path.join(workspaceDir, dev);
    if (!fs.statSync(devPath).isDirectory()) continue;

    for (const file of fs.readdirSync(devPath)) {
      if (!(file.startsWith("traces-") && file.endsWith(".md"))) continue;
      const oldPath = path.join(devPath, file);
      const newPath = path.join(devPath, file.replace("traces-", "journal-"));
      if (fs.existsSync(newPath)) {
        skipped.push(oldPath);
        continue;
      }
      fs.renameSync(oldPath, newPath);
      renamed++;
    }
  }
  return { renamed, skipped };
}
