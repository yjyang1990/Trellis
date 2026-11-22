import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";
const scripts = path.resolve(__dirname, "../../src/templates/trellis/scripts");
let repo: string;

function task(...args: string[]) {
  return exec(python, [".trellis/scripts/task.py", ...args], { cwd: repo });
}

async function create(slug: string, parent?: string) {
  const { stdout } = await task(
    "create",
    slug,
    "--slug",
    slug,
    "--description",
    "fixture",
    "--no-start",
    "--base-branch",
    "main",
    ...(parent ? ["--parent", parent] : []),
  );
  return path.basename(stdout.trim());
}

function metadata(name: string): { parent: string | null; children: string[] } {
  return JSON.parse(
    fs.readFileSync(
      path.join(repo, ".trellis/tasks", name, "task.json"),
      "utf8",
    ),
  );
}

describe("task relationship commands in one checkout", () => {
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-relationships-"));
    fs.cpSync(scripts, path.join(repo, ".trellis/scripts"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(repo, ".trellis/.developer"), "name=tester\n");
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("lists every concurrently created child under its parent exactly once", async () => {
    const parent = await create("parent");
    const children = await Promise.all(
      Array.from({ length: 8 }, (_, i) => create(`kid-${i}`, parent)),
    );
    expect(metadata(parent).children.sort()).toEqual(children.sort());
    const { stdout } = await task("list");
    for (const child of children) {
      expect(metadata(child).parent).toBe(parent);
      expect(stdout.split(`    - ${child}/`)).toHaveLength(2);
    }
  });

  it("retains both sides of concurrent adds and removes on different children", async () => {
    const parent = await create("parent");
    const keep = await create("keep", parent);
    const oldChildren = [
      await create("old-a", parent),
      await create("old-b", parent),
    ];
    const newChildren = await Promise.all(
      ["new-a", "new-b"].map((s) => create(s)),
    );
    await Promise.all([
      ...oldChildren.map((s) => task("remove-subtask", parent, s)),
      ...newChildren.map((s) => task("add-subtask", parent, s)),
    ]);
    expect(metadata(parent).children.sort()).toEqual(
      [keep, ...newChildren].sort(),
    );
    for (const name of [keep, ...newChildren])
      expect(metadata(name).parent).toBe(parent);
    for (const name of oldChildren) expect(metadata(name).parent).toBeNull();
  });

  it("allows only one parent to claim a child and preserves the winner on a wrong-parent unlink", async () => {
    const child = await create("kid");
    const parents = await Promise.all([create("first"), create("second")]);
    const attempts = await Promise.allSettled(
      parents.map((p) => task("add-subtask", p, child)),
    );
    const [winner, loser] =
      metadata(child).parent === parents[0] ? parents : [...parents].reverse();
    expect(attempts[parents.indexOf(winner)].status).toBe("fulfilled");
    expect(attempts[parents.indexOf(loser)]).toMatchObject({
      status: "rejected",
      reason: {
        code: 1,
        stderr: expect.stringContaining(`already has a parent: ${winner}`),
      },
    });
    await expect(task("remove-subtask", loser, child)).rejects.toMatchObject({
      code: 1,
    });
    expect(metadata(winner).children).toEqual([child]);
    expect(metadata(loser).children).toEqual([]);
    expect(metadata(child).parent).toBe(winner);
  });

  it("reports a lock failure before creating a child and still permits reading and standalone creation", async () => {
    const parent = await create("parent");
    fs.writeFileSync(path.join(repo, ".trellis/.runtime"), "blocked");
    await expect(create("kid", parent)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Cannot lock task relationships"),
    });
    expect(metadata(parent).children).toEqual([]);
    expect(fs.readdirSync(path.join(repo, ".trellis/tasks")).sort()).toEqual(
      [parent, "archive"].sort(),
    );
    await create("standalone");
    expect((await task("list")).stdout).toContain(`${parent}/`);
  });
});
