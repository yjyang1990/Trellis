// Run from the workspace root after pnpm build, just as CI does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAgentTemplate } from "../src/templates/read-agent-template.js";

const packages = fileURLToPath(new URL("../../", import.meta.url));
const scratch = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), "trellis-upgrades-"),
);
const cliName = "@mindfoldhq/trellis";
const coreName = "@mindfoldhq/trellis-core";
const receipt = ".trellis/.template-hashes.json";
const versionFile = ".trellis/.version";
const settings = ".claude/settings.json";
const sharedSkill = ".agents/skills/trellis-check/SKILL.md";
const codexSkill = ".agents/skills/trellis-continue/SKILL.md";
const env = {
  PATH: process.env.PATH,
  HOME: path.join(scratch, "home"),
  CI: "true",
};

try {
  fs.mkdirSync(env.HOME);
  console.log("Packing and installing the candidate CLI and core");
  const [core, cli] = ["core", "cli"].map((pkg) => {
    const dir = makeDir(`pack-${pkg}`);
    execFileSync("pnpm", ["pack", "--pack-destination", dir], {
      cwd: path.join(packages, pkg),
    });
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1, `Expected one ${pkg} tarball`);
    return path.join(dir, files[0]);
  });
  const installDir = makeDir("candidate");
  fs.writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { [cliName]: `file:${cli}`, [coreName]: `file:${core}` },
      overrides: { [coreName]: `$${coreName}` },
    }),
  );
  const candidate = install(installDir, []);
  for (const host of [
    "claude",
    "cursor",
    "codebuddy",
    "droid",
    "gemini",
    "qoder",
    "trae",
    "zcode",
  ]) {
    const dir = host === "droid" ? "droids" : "agents";
    for (const role of ["implement", "check", "research"]) {
      const file = path.join(host, dir, `trellis-${role}.md`);
      const source = path.join(packages, "cli/src/templates", file);
      const packed = readText(
        path.join(installDir, "node_modules", cliName, "dist/templates"),
        file,
      );
      assert.equal(packed, readAgentTemplate(source), file);
      assert.match(packed, /^---\r?\n[\s\S]+?\r?\n---\r?\n/, file);
      assert.match(packed, new RegExp(`^# ${role} Agent$`, "im"), file);
      assert.doesNotMatch(packed, /\{\{AGENT_BODY:/, file);
    }
  }
  const { packages: installed } = readJson(
    path.join(installDir, "package-lock.json"),
  );
  for (const [name, archive] of [
    [cliName, cli],
    [coreName, core],
  ]) {
    const digest = createHash("sha512")
      .update(fs.readFileSync(archive))
      .digest("base64");
    assert.equal(
      installed[`node_modules/${name}`].integrity,
      `sha512-${digest}`,
      name,
    );
  }
  const coreManifest = createRequire(candidate).resolve(
    `${coreName}/package.json`,
  );
  assert.equal(
    coreManifest,
    path.join(installDir, "node_modules", coreName, "package.json"),
  );
  const version = readJson(path.join(packages, "cli/package.json")).version;
  assert.equal(readJson(coreManifest).version, version);
  assert.equal(
    readJson(path.join(path.dirname(candidate), "../package.json"))
      .dependencies[coreName],
    version,
  );

  for (const [oldVersion, flags] of [
    ["0.4.0", ["--claude"]],
    ["0.6.7", ["--pi", "--codex"]],
  ]) {
    console.log(
      `${oldVersion}: installing published CLI and initializing fixture`,
    );
    const historical = install(makeDir(`install-${oldVersion}`), [
      `${cliName}@${oldVersion}`,
    ]);
    const project = initProject(`project-${oldVersion}`, historical, flags);
    assert.equal(readText(project, versionFile).trim(), oldVersion);
    const old = readJson(path.join(project, receipt));
    if (oldVersion === "0.4.0") {
      assert.equal(old.__version, undefined);
      checkHash(project, settings, old);
      checkHash(project, ".claude/hooks/ralph-loop.py", old);
    } else {
      assert.equal(old.__version, 2);
      checkHash(project, ".pi/skills/trellis-check/SKILL.md", old.hashes);
      checkHash(project, sharedSkill, old.hashes);
      checkHash(project, codexSkill, old.hashes);
    }

    console.log(
      `${oldVersion}: comparing upgrade to fresh ${version} installation`,
    );
    // 0.4.0 enabled the status line by default. Current init makes it opt-in.
    const freshFlags =
      oldVersion === "0.4.0" ? [...flags, "--with-statusline"] : flags;
    const fresh = initProject(`fresh-${oldVersion}`, candidate, freshFlags);
    const update = [candidate, "update", "--migrate", "--force"];
    run(process.execPath, update, project);
    assert.equal(readText(project, versionFile).trim(), version);
    const current = readJson(path.join(project, receipt));
    assert.equal(current.__version, 2);
    if (oldVersion === "0.4.0") {
      const content = readText(project, settings);
      assert.equal(content, readText(fresh, settings));
      checkHash(project, settings, current.hashes);
      const { hooks, statusLine } = JSON.parse(content);
      assert.ok(
        hooks.UserPromptSubmit.length,
        "Missing current Claude workflow hook",
      );
      for (const group of Object.values(hooks).flat()) {
        for (const { command } of group.hooks) {
          const [, script] = command.match(/\s(\.claude\/hooks\/\S+)$/) ?? [];
          assert.ok(script, `Expected a bundled Claude hook in ${command}`);
          assert.equal(
            readText(project, script),
            readText(fresh, script),
            script,
          );
          checkHash(project, script, current.hashes);
        }
      }
      assert.ok(
        fs
          .statSync(path.join(project, statusLine.command.split(" ").at(-1)))
          .isFile(),
      );
    } else {
      const expected = readJson(path.join(fresh, receipt)).hashes;
      const skillFiles = (hashes) =>
        Object.keys(hashes)
          .filter((key) => key.startsWith(".agents/skills/"))
          .sort();
      const skills = skillFiles(expected);
      assert.ok(skills.includes(sharedSkill) && skills.includes(codexSkill));
      assert.deepEqual(skillFiles(current.hashes), skills);
      for (const file of skills) {
        assert.equal(readText(project, file), readText(fresh, file), file);
        checkHash(project, file, current.hashes);
      }
      assert.ok(
        !fs.existsSync(path.join(project, ".pi/skills")),
        "Legacy Pi skills remain on disk",
      );
      assert.ok(
        !Object.keys(current.hashes).some((file) =>
          file.startsWith(".pi/skills/"),
        ),
        "Legacy Pi receipts remain",
      );
    }

    console.log(`${oldVersion}: checking second update for writes`);
    const before = snapshot(project);
    run(process.execPath, update, project);
    const after = snapshot(project);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    for (const file of Object.keys(before))
      assert.deepEqual(after[file], before[file], file);
    console.log(`${oldVersion} → ${version} passed`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

function makeDir(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir);
  return dir;
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function install(dir, specs) {
  run(
    "npm",
    [
      "install",
      "--prefix",
      dir,
      "--registry=https://registry.npmjs.org/",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...specs,
    ],
    scratch,
  );
  return path.join(dir, "node_modules", cliName, "bin/trellis.js");
}

function initProject(name, cli, flags) {
  const dir = makeDir(name);
  run("git", ["init", "--quiet"], dir);
  run(process.execPath, [cli, "init", ...flags, "-y", "-u", "tester"], dir);
  return dir;
}

function readText(dir, file) {
  return fs.readFileSync(path.join(dir, file), "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function checkHash(dir, file, hashes) {
  const text = readText(dir, file).replaceAll("\r\n", "\n");
  assert.equal(
    hashes[file],
    createHash("sha256").update(text).digest("hex"),
    file,
  );
}

function snapshot(dir) {
  const files = {};
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(dir, relative), {
      withFileTypes: true,
    })) {
      const file = path.join(relative, entry.name);
      if (file === ".git") continue;
      if (entry.isDirectory()) {
        walk(file);
      } else {
        const full = path.join(dir, file);
        const hash = createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
        files[file] = [hash, fs.statSync(full, { bigint: true }).mtimeNs];
      }
    }
  }
  walk("");
  return files;
}
