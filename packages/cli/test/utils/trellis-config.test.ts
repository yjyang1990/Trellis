import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseTrellisConfig } from "../../src/utils/trellis-config.js";
import { parseChannelTrustSection } from "../../src/commands/channel/context-trust.js";
import { parseWorkerGuardSection } from "../../src/commands/channel/guard.js";
import { getExtensionTemplate } from "../../src/templates/omp/index.js";

const fixture = [
  "channel:  # scope",
  "    worker_guard:",
  '       idle_timeout: "5m"  # TTL',
  "       max_live_workers: 3",
  "    trusted_context_dirs:",
  '        - "path # hash"  # explanation',
  "        - name: bogus",
  "          auto_trust_trellis_symlinks: true",
  "          trusted_context_dirs:",
  "            - /nested",
  "        - /partial",
  "          unsupported continuation",
  "        - [flow]",
  `        - "key": "value"`,
  `        - "key" : "value"`,
  "        - path#fragment",
  "        - user's path  # explanation",
  "    auto_trust_trellis_symlinks: 'false'",
  "    sibling:",
  "        trusted_context_dirs:",
  "          - /unrelated",
  "update:",
  "  skip:  # directory and file",
  "  - .claude/agents/  # keep",
  "  - teams' file.md  # keep",
  "  - 𠀀'𠀁.md  # keep",
  "  # between items",
  "",
  '  - "AGENTS.md"',
  "notes: |",
  "# comment outside indent",
  "  trusted_context_dirs: ignored",
  'command: echo --flag=" # inside"  # outside',
  "blank: ''",
].join("\r\n");
const trustedDirs = ["path # hash", "path#fragment", "user's path"];

it("reads the same config subset in the CLI and shipped standalone Python", () => {
  const expected = {
    channel: {
      worker_guard: { idle_timeout: "5m", max_live_workers: "3" },
      trusted_context_dirs: trustedDirs,
      auto_trust_trellis_symlinks: "false",
      sibling: { trusted_context_dirs: ["/unrelated"] },
    },
    update: { skip: [".claude/agents/", "teams' file.md", "𠀀'𠀁.md", "AGENTS.md"] },
    command: 'echo --flag=" # inside"',
    blank: "",
  };
  expect(parseTrellisConfig(fixture)).toEqual(expected);
  const script = fileURLToPath(
    new URL(
      "../../src/templates/trellis/scripts/common/trellis_config.py",
      import.meta.url,
    ),
  );
  const py = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-c",
      'import json, runpy, sys; print(json.dumps(runpy.run_path(sys.argv[1])["parse_simple_yaml"](sys.stdin.read())))',
      script,
    ],
    { encoding: "utf8", input: fixture },
  );
  expect(py.status, py.stderr).toBe(0);
  expect(JSON.parse(py.stdout)).toEqual(expected);
  expect(parseChannelTrustSection(fixture)).toEqual({
    trustedDirs,
    autoTrustSymlinks: false,
  });
  expect(parseWorkerGuardSection(fixture)).toEqual({
    idleTimeoutMs: 300_000,
    maxLiveWorkers: 3,
  });
});

it("uses the same standalone parser and trust reader in installed OMP extensions", () => {
  const parser = fs.readFileSync(
    new URL("../../src/utils/trellis-config.ts", import.meta.url),
    "utf8",
  );
  const cli = fs.readFileSync(
    new URL("../../src/commands/channel/context-trust.ts", import.meta.url),
    "utf8",
  );
  const reader = cli.slice(
    cli.indexOf("interface ChannelTrustConfig"),
    cli.indexOf("function loadChannelTrustConfig"),
  );
  const extension = getExtensionTemplate();
  expect(extension).toContain(parser.replace(/^export /gm, ""));
  expect(extension).toContain(reader.replace(/^export /gm, ""));
  expect(
    fs.readFileSync(
      new URL("../../../../.omp/extensions/trellis/index.ts", import.meta.url),
      "utf8",
    ),
  ).toBe(extension);
});

it.each(["[1]", "&alias", "nope"])(
  "rejects a malformed explicit guard value %s",
  (value) => {
    expect(() =>
      parseWorkerGuardSection(
        `channel:\n    worker_guard:\n        max_live_workers: ${value}`,
      ),
    ).toThrow(/non-negative integer/);
  },
);
