import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadSpecRegistryConfig,
  writeSpecRegistryConfig,
} from "../../src/utils/registry-config.js";

describe("registry-config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-reg-config-"));
    fs.mkdirSync(path.join(tmpDir, ".trellis"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when config.yaml is missing", () => {
    expect(loadSpecRegistryConfig(tmpDir)).toBeNull();
  });

  it("writes and reads registry spec source", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", "config.yaml"),
      "# Trellis Configuration\n",
      "utf-8",
    );

    writeSpecRegistryConfig(tmpDir, { source: "gitlab:org/repo/spec" });

    expect(loadSpecRegistryConfig(tmpDir)).toEqual({
      source: "gitlab:org/repo/spec",
    });
  });

  it("writes and reads registry marketplace template source", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", "config.yaml"),
      "# Trellis Configuration\n",
      "utf-8",
    );

    writeSpecRegistryConfig(tmpDir, {
      source: "gitlab:org/repo/marketplace",
      template: "golang-spec",
    });

    expect(loadSpecRegistryConfig(tmpDir)).toEqual({
      source: "gitlab:org/repo/marketplace",
      template: "golang-spec",
    });
  });

  it("preserves self-hosted SSH registry source strings", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", "config.yaml"),
      "# Trellis Configuration\n",
      "utf-8",
    );

    writeSpecRegistryConfig(tmpDir, {
      source: "git@git.ppdaicorp.com:xionghongwei/trellis-spec.git",
      template: "golang-spec",
    });

    expect(loadSpecRegistryConfig(tmpDir)).toEqual({
      source: "git@git.ppdaicorp.com:xionghongwei/trellis-spec.git",
      template: "golang-spec",
    });
  });

  it("reads quoted registry spec source", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", "config.yaml"),
      "registry:\n  spec:\n    source: 'gh:org/repo/spec#main'\n    template: \"backend\"\n",
      "utf-8",
    );

    expect(loadSpecRegistryConfig(tmpDir)).toEqual({
      source: "gh:org/repo/spec#main",
      template: "backend",
    });
  });

  it("does not duplicate an existing registry section", () => {
    const configPath = path.join(tmpDir, ".trellis", "config.yaml");
    fs.writeFileSync(
      configPath,
      "registry:\n  spec:\n    source: gh:org/repo/spec\n",
      "utf-8",
    );

    writeSpecRegistryConfig(tmpDir, { source: "gh:other/repo/spec" });

    const config = fs.readFileSync(configPath, "utf-8");
    expect(config.match(/^registry:/gm)).toHaveLength(1);
    expect(loadSpecRegistryConfig(tmpDir)).toEqual({
      source: "gh:other/repo/spec",
    });
  });

  it("round-trips custom indentation, comments, and neighboring sections", () => {
    const configPath = path.join(tmpDir, ".trellis", "config.yaml");
    const original = [
      "registry: # registry settings",
      "    spec:  # chosen spec",
      "       unknown:",
      "         source: neighbor",
      "       source: gh:old  # source note",
      "       template: 'old # template'  # template note",
      "    marketplace:",
      "       source: gh:market",
      "after: value",
      "",
    ].join("\r\n");
    fs.writeFileSync(configPath, original);
    const config = { source: "gh:org/repo#branch", template: "new # template" };
    for (let i = 0; i < 2; i++) {
      writeSpecRegistryConfig(tmpDir, config);
      expect(loadSpecRegistryConfig(tmpDir)).toEqual(config);
      expect(fs.readFileSync(configPath, "utf8")).toBe(
        original
          .replace("gh:old", config.source)
          .replace("'old # template'", '"new # template"'),
      );
    }
    writeSpecRegistryConfig(tmpDir, { source: config.source });
    expect(loadSpecRegistryConfig(tmpDir)).toEqual({ source: config.source });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "       # template note\r\n    marketplace:",
    );
  });

  it("retains each line ending and keeps comments outside literal values", () => {
    const file = path.join(tmpDir, ".trellis", "config.yaml");
    const original =
      "registry:\r\n  spec:\n    source: old  # source note\r\nneighbor: keep\n";
    fs.writeFileSync(file, original);
    const config = { source: 'cli "nightly', template: "backend" };
    writeSpecRegistryConfig(tmpDir, config);
    expect(loadSpecRegistryConfig(tmpDir)).toEqual(config);
    expect(fs.readFileSync(file, "utf8")).toBe(
      original.replace("    source: old", `    template: backend\n    source: 'cli "nightly'`),
    );
    writeSpecRegistryConfig(tmpDir, { source: "old" });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it.each(["|", "|-", ">2", `alpha 'quote' "word" # fragment`])(
    "round-trips literal registry value %s",
    (value) => {
      fs.writeFileSync(path.join(tmpDir, ".trellis", "config.yaml"), "");
      writeSpecRegistryConfig(tmpDir, { source: value });
      expect(loadSpecRegistryConfig(tmpDir)).toEqual({ source: value });
    },
  );

  it("removes the final template field without adding a trailing newline", () => {
    const file = path.join(tmpDir, ".trellis", "config.yaml");
    const base = "registry:\n  spec:\r\n    source: keep";
    fs.writeFileSync(file, `${base}\r\n    template: old`);
    writeSpecRegistryConfig(tmpDir, { source: "keep" });
    expect(fs.readFileSync(file, "utf8")).toBe(base);
  });

  it("preserves the file when a value needs unsupported quoting", () => {
    const file = path.join(tmpDir, ".trellis", "config.yaml");
    fs.writeFileSync(file, "# existing config\n");
    expect(() =>
      writeSpecRegistryConfig(tmpDir, {
        source: `open ' and " # fragment`,
      }),
    ).toThrow(/supported config quoting/);
    expect(fs.readFileSync(file, "utf8")).toBe("# existing config\n");
  });

  it("leaves duplicate managed keys untouched even when the second value is unsupported", () => {
    const file = path.join(tmpDir, ".trellis", "config.yaml");
    const content =
      "registry:\n  spec:\n    source: old\n    source: [ambiguous]\n";
    fs.writeFileSync(file, content);
    expect(() => writeSpecRegistryConfig(tmpDir, { source: "new" })).toThrow(
      /duplicate source/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });

  it("preserves the file when a managed registry field has an unsupported body", () => {
    const file = path.join(tmpDir, ".trellis", "config.yaml");
    const content =
      "registry:\n  spec:\n    source: old\n    template:\n      - mine\n    neighbor: keep\n";
    fs.writeFileSync(file, content);
    expect(() => writeSpecRegistryConfig(tmpDir, { source: "new" })).toThrow(
      /registry\.spec\.template/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });

  it("updates an existing registry section", () => {
    const configPath = path.join(tmpDir, ".trellis", "config.yaml");
    fs.writeFileSync(
      configPath,
      "registry:\n  spec:\n    source: gitlab:old/spec\n",
      "utf-8",
    );

    writeSpecRegistryConfig(tmpDir, {
      source: "git@git.ppdaicorp.com:xionghongwei/trellis-spec.git",
      template: "golang-spec",
    });

    const config = fs.readFileSync(configPath, "utf-8");
    expect(config.match(/^registry:/gm)).toHaveLength(1);
    expect(loadSpecRegistryConfig(tmpDir)).toEqual({
      source: "git@git.ppdaicorp.com:xionghongwei/trellis-spec.git",
      template: "golang-spec",
    });
  });

  it("adds spec config under an existing registry section", () => {
    const configPath = path.join(tmpDir, ".trellis", "config.yaml");
    fs.writeFileSync(
      configPath,
      "registry:\n  marketplace:\n    source: gh:org/marketplace\n\ncommands:\n  skip: []\n",
      "utf-8",
    );

    writeSpecRegistryConfig(tmpDir, {
      source: "gh:org/specs/golang",
      template: "golang-spec",
    });

    const config = fs.readFileSync(configPath, "utf-8");
    expect(config.match(/^registry:/gm)).toHaveLength(1);
    expect(config).toContain("  marketplace:\n    source: gh:org/marketplace");
    expect(loadSpecRegistryConfig(tmpDir)).toEqual({
      source: "gh:org/specs/golang",
      template: "golang-spec",
    });
  });
});
