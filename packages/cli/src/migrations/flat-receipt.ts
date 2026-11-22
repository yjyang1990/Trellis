import fs from "node:fs";
import path from "node:path";
import { PLATFORM_IDS } from "../configurators/index.js";
import { AI_TOOLS, type AITool } from "../types/ai-tools.js";
import type { TemplateHashes } from "../types/migration.js";
import { toPosix } from "../utils/posix.js";
import { receipts040 } from "./receipts-040.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only trusted release/template paths may be passed to this preflight. */
export function checkLegacyPaths(cwd: string, paths: Iterable<string>): void {
  for (const key of paths) {
    let current = cwd;
    for (const segment of key.split("/")) {
      current = path.join(current, segment);
      const entry = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!entry) break;
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Review symbolic link ${toPosix(path.relative(cwd, current))} before upgrading the legacy installation.`,
        );
      }
      if (!entry.isDirectory()) break;
    }
  }
}

// One file is native OpenCode metadata, the other is an empty release stub.
const incidentalOpenCodeFiles = new Set([
  ".opencode/package.json",
  ".opencode/commands/trellis/migrate-specs.md",
]);

/** Old init hashed native directories recursively, including skipped user files. */
export function readFlatReceipt040(cwd: string): TemplateHashes | undefined {
  const receipt = path.join(cwd, ".trellis/.template-hashes.json");
  if (!fs.existsSync(receipt)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(receipt, "utf8"));
  } catch {
    return;
  }
  if (!isObject(parsed) || "__version" in parsed) return;
  const entries = new Map<string, string>();
  for (const [rawKey, digest] of Object.entries(parsed)) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return;
    const key = toPosix(rawKey);
    if (entries.has(key))
      throw new Error(`Duplicate legacy receipt path: ${key}`);
    entries.set(key, digest);
  }

  const hashes: TemplateHashes = {};
  for (const [key, lf, crlf] of receipts040) {
    const digest = entries.get(key);
    if (digest === lf || digest === crlf) hashes[key] = lf;
  }
  if (!platformsFromReceipts040(hashes).has("opencode")) {
    for (const file of incidentalOpenCodeFiles)
      Reflect.deleteProperty(hashes, file);
  }
  checkLegacyPaths(cwd, Object.keys(hashes));
  return hashes;
}

/** Both the flat conversion and its persisted v2 intermediate use this evidence. */
export function platformsFromReceipts040(hashes: TemplateHashes): Set<AITool> {
  const evidence = receipts040.filter(
    ([key, lf]) => !incidentalOpenCodeFiles.has(key) && hashes[key] === lf,
  );
  return new Set(
    PLATFORM_IDS.filter((id) => {
      const root =
        id === "devin" ? ".windsurf/workflows" : AI_TOOLS[id].configDir;
      return evidence.some(([key]) => key.startsWith(`${root}/`));
    }),
  );
}

export const retiredRalphHook = ".claude/hooks/ralph-loop.py";

/** Plan a surgical edit of active 0.4.x settings before retiring the script. */
export function cleanLegacyRalphSettings(
  cwd: string,
  settingsFile: string,
  owned: boolean,
): string | undefined {
  const settingsPath = path.join(cwd, settingsFile);
  if (!fs.existsSync(settingsPath)) return;
  const blocked = new Error(
    `Review ${settingsFile} before removing ${retiredRalphHook}. Remove its hook reference and retry trellis update.`,
  );
  const content = fs.readFileSync(settingsPath, "utf8");
  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch {
    throw blocked;
  }
  if (!isObject(settings)) throw blocked;
  const containsReference = (value: unknown): boolean =>
    /ralph-loop\.py/i.test(JSON.stringify(value));
  if (!containsReference(settings)) return;
  if (!owned || !isObject(settings.hooks)) throw blocked;
  const groups: unknown = settings.hooks.SubagentStop;
  if (!Array.isArray(groups)) throw blocked;
  const retained = groups.filter((group: unknown) => {
    if (
      !isObject(group) ||
      group.matcher !== "check" ||
      Object.keys(group).length !== 2 ||
      !Array.isArray(group.hooks)
    )
      return true;
    const handlers = group.hooks.filter(
      (hook: unknown) =>
        !(
          isObject(hook) &&
          Object.keys(hook).length === 3 &&
          hook.type === "command" &&
          hook.timeout === 10 &&
          (hook.command === `python3 ${retiredRalphHook}` ||
            hook.command === `python ${retiredRalphHook}`)
        ),
    );
    if (handlers.length === group.hooks.length) return true;
    group.hooks = handlers;
    return handlers.length > 0;
  });
  if (retained.length > 0) settings.hooks.SubagentStop = retained;
  else delete settings.hooks.SubagentStop;
  if (containsReference(settings)) throw blocked;
  return `${JSON.stringify(settings, null, 2)}\n`;
}
