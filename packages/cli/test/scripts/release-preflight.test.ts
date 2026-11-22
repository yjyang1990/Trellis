import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = fileURLToPath(new URL("../../", import.meta.url));
const version = "1.2.3-beta.1";
const empty = { version, migrations: [] };
let root: string;
let cli: string;
let manifest: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-release-preflight-"));
  cli = path.join(root, "packages/cli");
  manifest = path.join(cli, `src/migrations/manifests/${version}.json`);
  for (const name of ["core", "cli"]) {
    const dir = path.join(root, "packages", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version, type: "module" }),
    );
  }
  for (const file of [
    "scripts/release-preflight.js",
    "src/migrations/read-manifest.js",
  ]) {
    fs.mkdirSync(path.dirname(path.join(cli, file)), { recursive: true });
    fs.copyFileSync(path.join(cliRoot, file), path.join(cli, file));
  }
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function preflight(tagged = true) {
  return spawnSync(
    process.execPath,
    [
      path.join(cli, "scripts/release-preflight.js"),
      "check-versions",
      ...(tagged ? ["--require-tag"] : []),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REF: "",
        GITHUB_REF_NAME: tagged ? `v${version}` : "",
      },
    },
  );
}

function writeManifest(contents: string | Buffer) {
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, contents);
}

describe("target release manifest", () => {
  it.each([true, false])(
    "requires a target and accepts a valid empty manifest (tagged=%s)",
    (tagged) => {
      const missing = preflight(tagged);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(`${version}.json`);
      expect(missing.stderr).toContain("ENOENT");
      writeManifest(JSON.stringify({ ...empty, notes: { tracking: 12 } }));
      const valid = preflight(tagged);
      expect(valid.status, valid.stderr).toBe(0);
    },
  );

  it("rejects invalid UTF-8 bytes in a migration path", () => {
    writeManifest(
      Buffer.concat([
        Buffer.from(
          `{"version":"${version}","migrations":[{"type":"delete","from":"`,
        ),
        Buffer.from([0xff]),
        Buffer.from('"}]}'),
      ]),
    );
    const result = preflight();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${version}.json`);
    expect(result.stderr).toMatch(/utf-8/i);
  });

  it.each([
    {
      breaking: true,
      recommendMigrate: true,
      migrationGuide: "升级指南",
      aiInstructions: "Check the project",
    },
    { breaking: true, recommendMigrate: false },
    { breaking: false, recommendMigrate: true },
  ])(
    "accepts UTF-8 with a BOM and guidance appropriate to the flags %o",
    (metadata) => {
      writeManifest("\uFEFF" + JSON.stringify({ ...empty, ...metadata }));
      const result = preflight();
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    ["{", "JSON"],
    ...["migrationGuide", "aiInstructions"].flatMap((field) =>
      [undefined, " \t", 3].map((value) => [
        JSON.stringify({
          ...empty,
          breaking: true,
          recommendMigrate: true,
          migrationGuide: "Guide",
          aiInstructions: "Instructions",
          [field]: value,
        }),
        field,
      ]),
    ),
    [JSON.stringify({ ...empty, version: "1.2.4" }), "does not match filename"],
    ["null", "must be an object"],
    [JSON.stringify({ version }), "migrations must be an array"],
    ...[
      [null, " must be an object"],
      [{ type: "unknown", from: "a" }, ".type"],
      [{ type: "delete", from: " " }, ".from"],
      [{ type: "rename", from: "a" }, ".to"],
      [{ type: "rename-dir", from: "a", to: 3 }, ".to"],
      [{ type: "safe-file-delete", from: "a" }, ".allowed_hashes"],
      [
        { type: "safe-file-delete", from: "a", allowed_hashes: [] },
        ".allowed_hashes",
      ],
      [
        { type: "safe-file-delete", from: "a", allowed_hashes: ["bad"] },
        ".allowed_hashes",
      ],
    ].map(([item, reason]) => [
      JSON.stringify({ version, migrations: [item] }),
      `migrations[0]${reason}`,
    ]),
    [
      JSON.stringify({ ...empty, configSectionsAdded: [{}] }),
      "configSectionsAdded[0].file",
    ],
  ])("rejects %s", (body, reason) => {
    writeManifest(body);
    const result = preflight();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${version}.json`);
    expect(result.stderr).toContain(reason);
  });
});
