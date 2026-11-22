import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSafeManagedPath,
  buildManagedRemovalPlan,
  buildStructuredFileSpecs,
  validateManagedRelativePath,
} from "../../src/utils/managed-removal.js";

import {
  collectPlatformTemplates,
  PLATFORM_IDS,
} from "../../src/configurators/index.js";

it("registers every installed shared JSON and leaves dedicated Trellis resources opaque", () => {
  const ownedResources = new Set([
    ".kiro/agents/trellis.json",
    ".kiro/agents/trellis-check.json",
    ".kiro/agents/trellis-implement.json",
    ".kiro/agents/trellis-research.json",
    ".github/hooks/trellis.json",
    ".snow/commands/trellis-continue.json",
    ".snow/commands/trellis-finish-work.json",
  ]);
  const installed = new Set(
    PLATFORM_IDS.flatMap((platform) =>
      [...(collectPlatformTemplates(platform)?.keys() ?? [])].filter((file) =>
        file.endsWith(".json"),
      ),
    ),
  );
  const registered = [...buildStructuredFileSpecs().keys()].filter((file) =>
    file.endsWith(".json"),
  );
  expect(new Set(registered)).toEqual(
    new Set([...installed].filter((file) => !ownedResources.has(file))),
  );
  for (const path of ownedResources)
    expect(installed.has(path), path).toBe(true);
});

describe("managed-removal strict planning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-removal-plan-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    "",
    "/absolute",
    "C:/escape",
    "C:escape",
    "../escape",
    "a/../b",
    "a//b",
    "./a",
    "a\\b",
    "a\0b",
  ])("rejects invalid manifest path %j", (managedPath) => {
    expect(() => validateManagedRelativePath(managedPath)).toThrow();
  });

  it("accepts a relative POSIX manifest path", () => {
    expect(() =>
      validateManagedRelativePath(".codex/hooks/session-start.py"),
    ).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "refuses traversal through an external parent symlink",
    () => {
      const external = path.join(tmpDir, "external");
      const project = path.join(tmpDir, "project");
      fs.mkdirSync(external);
      fs.mkdirSync(project);
      fs.symlinkSync(external, path.join(project, ".codex"));

      expect(() => assertSafeManagedPath(project, ".codex/hooks.json")).toThrow(
        /escapes project root/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "treats a leaf symlink as an opaque deletion",
    () => {
      const target = path.join(tmpDir, "target.json");
      fs.writeFileSync(target, '{"user":true}\n');
      fs.mkdirSync(path.join(tmpDir, ".codex"));
      fs.symlinkSync(target, path.join(tmpDir, ".codex", "hooks.json"));

      const plan = buildManagedRemovalPlan(
        tmpDir,
        { ".codex/hooks.json": "hash" },
        { strictPaths: true },
      );
      expect(plan.modifications).toEqual([]);
      expect(plan.deletions).toHaveLength(1);
      expect(plan.deletions[0]?.missing).toBe(false);
      expect(fs.readFileSync(target, "utf-8")).toBe('{"user":true}\n');
    },
  );

  it("fails closed when a malformed mixed file cannot be scrubbed", () => {
    fs.mkdirSync(path.join(tmpDir, ".codex"));
    fs.writeFileSync(path.join(tmpDir, ".codex", "hooks.json"), "{broken");

    expect(() =>
      buildManagedRemovalPlan(
        tmpDir,
        { ".codex/hooks.json": "hash" },
        { strictPaths: true },
      ),
    ).toThrow(/Cannot prove Trellis content was removed/);
  });
});
