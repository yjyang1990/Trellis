/**
 * Unit tests for uninstall-scrubbers.
 *
 * Each scrubber gets coverage for:
 *  - Strips trellis content
 *  - Preserves user-added content
 *  - Reports `fullyEmpty: true` when nothing meaningful remains
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  scrubHooksJson,
  scrubOpencodePackageJson,
  scrubPiSettings,
  scrubCodexConfigToml,
  scrubManagedMarkdownBlock,
} from "../../src/utils/uninstall-scrubbers.js";
import { getConfigTemplate as getCodexConfigTemplate } from "../../src/templates/codex/index.js";

import { computeHash } from "../../src/utils/template-hash.js";
import { buildStructuredFileSpecs } from "../../src/utils/managed-removal.js";
import { collectPlatformTemplates } from "../../src/configurators/index.js";

const CLAUDE_DELETE_PATHS = [
  ".claude/hooks/session-start.py",
  ".claude/hooks/inject-subagent-context.py",
  ".claude/hooks/inject-workflow-state.py",
  ".claude/hooks/statusline.py",
];

const CURSOR_DELETE_PATHS = [
  ".cursor/hooks/inject-subagent-context.py",
  ".cursor/hooks/session-start.py",
  ".cursor/hooks/inject-workflow-state.py",
  ".cursor/hooks/inject-shell-session-context.py",
];

const TEST_BLOCK_START = "<!-- TRELLIS:TEST:START -->";
const TEST_BLOCK_END = "<!-- TRELLIS:TEST:END -->";

describe("scrubHooksJson — nested schema", () => {
  it("strips trellis hook entries from a Claude-style file", () => {
    const input = {
      env: { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1" },
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                command: "python3 .claude/hooks/session-start.py",
                timeout: 10,
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "python3 .claude/hooks/inject-workflow-state.py",
                timeout: 5,
              },
            ],
          },
        ],
      },
      enabledPlugins: {},
    };

    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      CLAUDE_DELETE_PATHS,
      "nested",
    );
    const parsed = JSON.parse(content);
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.env).toEqual(input.env);
    expect(parsed.enabledPlugins).toEqual({});
    expect(fullyEmpty).toBe(false);
  });

  it("removes the exact opt-in Trellis statusLine while preserving other settings", () => {
    const input = {
      env: { USER_VALUE: "keep" },
      statusLine: {
        type: "command",
        command: "python3 .claude/hooks/statusline.py",
      },
    };
    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input),
      CLAUDE_DELETE_PATHS,
      "nested",
    );
    expect(JSON.parse(content)).toEqual({ env: input.env });
    expect(fullyEmpty).toBe(false);
  });

  it("preserves a user-owned Claude statusLine command", () => {
    const input = {
      statusLine: {
        type: "command",
        command: "python3 .claude/hooks/my-statusline.py",
      },
    };
    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input),
      CLAUDE_DELETE_PATHS,
      "nested",
    );
    expect(JSON.parse(content)).toEqual(input);
    expect(fullyEmpty).toBe(false);
  });

  it("preserves the Trellis-shaped statusLine when the manifest does not own it", () => {
    const input = {
      statusLine: {
        type: "command",
        command: "python3 .claude/hooks/statusline.py",
      },
    };
    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input),
      CLAUDE_DELETE_PATHS.filter(
        (managedPath) => managedPath !== ".claude/hooks/statusline.py",
      ),
      "nested",
    );
    expect(JSON.parse(content)).toEqual(input);
    expect(fullyEmpty).toBe(false);
  });

  it("preserves user-added hook entry inside the same matcher block", () => {
    const input = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                command: "python3 .claude/hooks/session-start.py",
                timeout: 10,
              },
              {
                type: "command",
                command: "python3 .claude/hooks/my-custom-hook.py",
                timeout: 5,
              },
            ],
          },
        ],
      },
    };

    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      CLAUDE_DELETE_PATHS,
      "nested",
    );
    const parsed = JSON.parse(content);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(
      "python3 .claude/hooks/my-custom-hook.py",
    );
    expect(fullyEmpty).toBe(false);
  });

  it("reports fullyEmpty when only trellis hooks existed", () => {
    const input = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                command: "python3 .claude/hooks/session-start.py",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };

    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      CLAUDE_DELETE_PATHS,
      "nested",
    );
    expect(fullyEmpty).toBe(true);
    // Content should still be valid JSON (an empty object).
    expect(JSON.parse(content)).toEqual({});
  });

  it("does NOT strip hook entries that merely mention a deleted path inside a string argument", () => {
    // Regression: substring-only matching would incorrectly delete a user
    // hook whose command happens to embed a manifest path in an echo/log arg.
    const input = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                command:
                  'echo "see .claude/hooks/session-start.py for inspiration" && python3 my-hook.py',
              },
            ],
          },
        ],
      },
    };
    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      CLAUDE_DELETE_PATHS,
      "nested",
    );
    const parsed = JSON.parse(content);
    // Token-based matcher should preserve the user's hook intact.
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(fullyEmpty).toBe(false);
  });

  it("collapses empty matcher blocks (whole block dropped when its hooks list goes to 0)", () => {
    const input = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                command: "python3 .claude/hooks/session-start.py",
              },
            ],
          },
          {
            matcher: "user",
            hooks: [
              { type: "command", command: "python3 .claude/hooks/user.py" },
            ],
          },
        ],
      },
    };
    const { content } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      CLAUDE_DELETE_PATHS,
      "nested",
    );
    const parsed = JSON.parse(content);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0].matcher).toBe("user");
  });
});

describe("scrubHooksJson — flat schema", () => {
  it("strips trellis hook entries from a Cursor-style file", () => {
    const input = {
      version: 1,
      hooks: {
        preToolUse: [
          {
            command: "python3 .cursor/hooks/inject-subagent-context.py",
            matcher: "Task|Subagent",
            timeout: 30,
          },
        ],
        sessionStart: [
          { command: "python3 .cursor/hooks/session-start.py", timeout: 10 },
        ],
      },
    };

    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      CURSOR_DELETE_PATHS,
      "flat",
    );
    const parsed = JSON.parse(content);
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.version).toBe(1);
    expect(fullyEmpty).toBe(false);
  });

  it("preserves user-added flat hook entries", () => {
    const input = {
      hooks: {
        preToolUse: [
          { command: "python3 .cursor/hooks/inject-subagent-context.py" },
          { command: "python3 .cursor/hooks/my-rule.py" },
        ],
      },
    };
    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      CURSOR_DELETE_PATHS,
      "flat",
    );
    const parsed = JSON.parse(content);
    expect(parsed.hooks.preToolUse).toHaveLength(1);
    expect(parsed.hooks.preToolUse[0].command).toBe(
      "python3 .cursor/hooks/my-rule.py",
    );
    expect(fullyEmpty).toBe(false);
  });

  it("matches Copilot bash/powershell command fields", () => {
    const copilotPaths = [
      ".github/copilot/hooks/session-start.py",
      ".github/copilot/hooks/inject-workflow-state.py",
    ];
    const input = {
      hooks: {
        SessionStart: [
          {
            type: "command",
            command: "python3 .github/copilot/hooks/session-start.py",
            timeout: 10,
          },
        ],
        userPromptSubmitted: [
          {
            type: "command",
            bash: "python3 .github/copilot/hooks/inject-workflow-state.py",
            powershell:
              "python3 .github/copilot/hooks/inject-workflow-state.py",
            timeoutSec: 5,
          },
        ],
      },
    };
    const { content, fullyEmpty } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      copilotPaths,
      "flat",
    );
    expect(fullyEmpty).toBe(true);
    expect(JSON.parse(content)).toEqual({});
  });

  it("reports fullyEmpty when only trellis hooks existed", () => {
    const input = {
      hooks: {
        sessionStart: [
          { command: "python3 .cursor/hooks/session-start.py", timeout: 10 },
        ],
      },
    };
    const { fullyEmpty } = scrubHooksJson(
      JSON.stringify(input, null, 2),
      CURSOR_DELETE_PATHS,
      "flat",
    );
    expect(fullyEmpty).toBe(true);
  });
});

describe("scrubOpencodePackageJson", () => {
  it("removes @opencode-ai/plugin and reports fullyEmpty", () => {
    const input = { dependencies: { "@opencode-ai/plugin": "1.1.40" } };
    const { content, fullyEmpty } = scrubOpencodePackageJson(
      JSON.stringify(input, null, 2),
    );
    expect(fullyEmpty).toBe(true);
    expect(JSON.parse(content)).toEqual({});
  });

  it("preserves other deps and other top-level fields", () => {
    const input = {
      name: "my-project",
      dependencies: {
        "@opencode-ai/plugin": "1.1.40",
        lodash: "^4.0.0",
      },
    };
    const { content, fullyEmpty } = scrubOpencodePackageJson(
      JSON.stringify(input, null, 2),
    );
    const parsed = JSON.parse(content);
    expect(parsed.name).toBe("my-project");
    expect(parsed.dependencies).toEqual({ lodash: "^4.0.0" });
    expect(fullyEmpty).toBe(false);
  });
});

describe("scrubManagedMarkdownBlock", () => {
  it("removes the managed block and preserves user markdown", () => {
    const input = `# User Guidance

Keep this.

${TEST_BLOCK_START}
# Managed
Remove this.
${TEST_BLOCK_END}

## Tail

Also keep this.
`;

    const { content, fullyEmpty } = scrubManagedMarkdownBlock(
      input,
      TEST_BLOCK_START,
      TEST_BLOCK_END,
    );

    expect(content).toBe(`# User Guidance

Keep this.

## Tail

Also keep this.
`);
    expect(fullyEmpty).toBe(false);
  });

  it("reports fullyEmpty when only the managed block remains", () => {
    const { content, fullyEmpty } = scrubManagedMarkdownBlock(
      `${TEST_BLOCK_START}\nmanaged\n${TEST_BLOCK_END}\n`,
      TEST_BLOCK_START,
      TEST_BLOCK_END,
    );

    expect(content).toBe("");
    expect(fullyEmpty).toBe(true);
  });

  it("leaves malformed marker pairs untouched", () => {
    const input = `${TEST_BLOCK_START}\nmanaged\n`;
    const { content, fullyEmpty } = scrubManagedMarkdownBlock(
      input,
      TEST_BLOCK_START,
      TEST_BLOCK_END,
    );

    expect(content).toBe(input);
    expect(fullyEmpty).toBe(false);
  });
});

describe("scrubPiSettings", () => {
  it("strips trellis entries and reports fullyEmpty", () => {
    const input = {
      enableSkillCommands: true,
      extensions: ["./extensions/trellis/index.ts"],
      skills: ["./skills"],
      prompts: ["./prompts"],
      packages: [
        {
          source: "npm:pi-subagents",
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
        },
      ],
    };
    const { content, fullyEmpty } = scrubPiSettings(
      JSON.stringify(input, null, 2),
    );
    expect(fullyEmpty).toBe(true);
    expect(JSON.parse(content)).toEqual({});
  });

  it("preserves user-added array entries", () => {
    const input = {
      enableSkillCommands: true,
      extensions: ["./extensions/trellis/index.ts", "./extensions/my-ext"],
      skills: ["./skills", "./other-skills"],
      prompts: ["./prompts"],
      packages: [
        {
          source: "npm:pi-subagents",
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
        },
        {
          source: "npm:user-package",
          skills: ["./pkg-skills"],
        },
      ],
      otherField: "user-value",
    };
    const { content, fullyEmpty } = scrubPiSettings(
      JSON.stringify(input, null, 2),
    );
    const parsed = JSON.parse(content);
    expect(parsed.enableSkillCommands).toBeUndefined();
    expect(parsed.extensions).toEqual(["./extensions/my-ext"]);
    expect(parsed.skills).toEqual(["./other-skills"]);
    expect(parsed.prompts).toBeUndefined();
    expect(parsed.packages).toEqual([
      {
        source: "npm:user-package",
        skills: ["./pkg-skills"],
      },
    ]);
    expect(parsed.otherField).toBe("user-value");
    expect(fullyEmpty).toBe(false);
  });
});

describe("scrubCodexConfigToml", () => {
  const TEMPLATE = `# Project-scoped Codex defaults for Trellis workflows.
# Codex loads this after ~/.codex/config.toml when you work in this project.

# Keep AGENTS.md as the primary project instruction file.
project_doc_fallback_filenames = ["AGENTS.md"]

# NOTE: Trellis's SessionStart + UserPromptSubmit hooks require opt-in.
# Add the following to your USER-level config at ~/.codex/config.toml
# (not this project file — features.* must be enabled globally):
#
#   [features]
#   codex_hooks = true
#
# Without this flag, hooks.json is ignored and Trellis context won't
# be injected into Codex sessions.
`;

  it("removes the entire trellis-shipped file and reports fullyEmpty", () => {
    const { content, fullyEmpty } = scrubCodexConfigToml(TEMPLATE);
    expect(fullyEmpty).toBe(true);
    expect(content.trim()).toBe("");
  });

  it("removes the complete current Codex template, including agents.max_depth", () => {
    const { content, fullyEmpty } = scrubCodexConfigToml(
      getCodexConfigTemplate().content,
    );
    expect(fullyEmpty).toBe(true);
    expect(content).toBe("");
  });

  it("preserves user-owned keys in the agents table while removing Trellis max_depth", () => {
    const mixed = `${getCodexConfigTemplate().content}user_key = "keep"\n`;
    const { content, fullyEmpty } = scrubCodexConfigToml(mixed);
    expect(fullyEmpty).toBe(false);
    expect(content).toContain("[agents]");
    expect(content).toContain('user_key = "keep"');
    expect(content).not.toContain("max_depth = 1");
    expect(content).not.toContain("Trellis");
  });

  it("stops agents cleanup before a user-owned array-of-tables section", () => {
    const input = `[agents]\nmax_depth = 1\n\n[[agents]]\nname = "user"\nmax_depth = 1\n`;
    const { content, fullyEmpty } = scrubCodexConfigToml(input);
    expect(fullyEmpty).toBe(false);
    expect(content).toBe(`[[agents]]\nname = "user"\nmax_depth = 1\n`);
  });

  it("preserves user-added TOML content", () => {
    const userContent = `${TEMPLATE}
# My custom config
[my_section]
my_key = "value"
`;
    const { content, fullyEmpty } = scrubCodexConfigToml(userContent);
    expect(fullyEmpty).toBe(false);
    expect(content).toContain("[my_section]");
    expect(content).toContain('my_key = "value"');
    expect(content).not.toContain("project_doc_fallback_filenames");
    expect(content).not.toContain("Trellis's SessionStart");
  });

  it("strips just the assignment line when comments are absent", () => {
    const minimal = `project_doc_fallback_filenames = ["AGENTS.md"]
[user_section]
key = 1
`;
    const { content, fullyEmpty } = scrubCodexConfigToml(minimal);
    expect(fullyEmpty).toBe(false);
    expect(content).not.toContain("project_doc_fallback_filenames");
    expect(content).toContain("[user_section]");
  });

  it("strips the new `hooks = true` marker line (Codex 0.129+) alongside the legacy `codex_hooks` line", () => {
    const newTemplate = `# Project-scoped Codex defaults for Trellis workflows.
# Codex loads this after ~/.codex/config.toml when you work in this project.

# Keep AGENTS.md as the primary project instruction file.
project_doc_fallback_filenames = ["AGENTS.md"]

# NOTE: Trellis's SessionStart + UserPromptSubmit hooks require opt-in.
# Add the following to your USER-level config at ~/.codex/config.toml
# (not this project file — features.* must be enabled globally):
#
#   [features]
#   hooks = true
#   codex_hooks = true
#
# Without this flag, hooks.json is ignored and Trellis context won't
# be injected into Codex sessions.
`;
    const { content, fullyEmpty } = scrubCodexConfigToml(newTemplate);
    expect(fullyEmpty).toBe(true);
    expect(content.trim()).toBe("");
  });
});

describe("manifest-backed platform event hooks", () => {
  const registry = buildStructuredFileSpecs();
  for (const platform of ["snow", "zcode"] as const) {
    const templates =
      collectPlatformTemplates(platform) ?? new Map<string, string>();
    for (const [path, pristine] of templates) {
      const spec = registry.get(path);
      if (!spec || !path.endsWith(".json")) continue;
      const paths = [...templates.keys()];
      it(`keeps ${path} byte-identical without evidence of a managed entry`, () => {
        for (const content of [
          "",
          "{invalid",
          "[]",
          "null",
          "{}",
          '{ "hooks": { "events": [] } }',
          '{"onSessionStart":[null,{"hooks":[]}]}',
        ]) {
          expect(spec.scrub(content, paths)).toEqual({
            content,
            fullyEmpty: false,
          });
        }
        expect(spec.scrub(pristine, [path])).toEqual({
          content: pristine,
          fullyEmpty: false,
        });
      });
      it(`preserves lookalike commands and unknown data in ${path}`, () => {
        const root = JSON.parse(pristine);
        const events = platform === "zcode" ? root.hooks.events : root;
        const event = Object.keys(events)[0];
        const group = events[event][0];
        const entry = group.hooks[0];
        const neighbors = [
          null,
          {},
          { ...entry, type: "future-type" },
          { ...entry, userField: "keep" },
          { ...entry, timeout: { custom: true } },
          { ...entry, command: "echo " + entry.command },
          { ...entry, command: entry.command + " --custom" },
          {
            ...entry,
            command: entry.command
              .replace(/ (session|user|subagent)$/, " another-mode")
              .replace(".zcode/", "other/.zcode/"),
          },
        ];
        group.hooks.push(...neighbors);
        events[event].push(
          {
            ...group,
            hooks: [entry],
            matcher: "user-matcher",
            userMetadata: 1,
          },
          { hooks: [] },
        );
        events.unrecognized = [entry];
        const result = spec.scrub(
          JSON.stringify(root),
          paths,
          computeHash(pristine),
        );
        expect(result.fullyEmpty).toBe(false);
        const after = JSON.parse(result.content);
        const remaining = platform === "zcode" ? after.hooks.events : after;
        expect(remaining[event]).toEqual([
          { ...group, hooks: neighbors },
          {
            ...group,
            hooks: [entry],
            matcher: "user-matcher",
            userMetadata: 1,
          },
          { hooks: [] },
        ]);
        expect(remaining.unrecognized).toEqual([entry]);
        expect(
          spec.scrub(result.content, paths, computeHash(pristine)),
        ).toEqual(result);
      });
    }
  }

  it.each([
    "alternate launcher",
    "different matcher",
    "identical duplicates",
  ] as const)("preserves a ZCode user registration with %s", (kind) => {
    const path = ".zcode/config.json";
    const templates = collectPlatformTemplates("zcode");
    const pristine = templates?.get(path);
    const spec = registry.get(path);
    if (!templates || !pristine || !spec)
      throw new Error("Missing ZCode templates or scrubber");
    const paths = [...templates.keys()];
    const hash = computeHash(pristine);
    const config = JSON.parse(pristine);
    const [agentGroup, bashGroup] = config.hooks.events.PreToolUse;
    const owned = bashGroup.hooks[0];
    const user = { ...owned };
    const group = kind === "different matcher" ? agentGroup : bashGroup;
    if (kind === "alternate launcher") {
      user.command = owned.command.replace(
        /^.+? /,
        owned.command.startsWith("python ") ? "python3 " : "python ",
      );
    }
    group.hooks.push(user);
    const result = spec.scrub(JSON.stringify(config), paths, hash);
    expect(result.fullyEmpty).toBe(false);
    const remaining = JSON.parse(result.content).hooks.events;
    expect(remaining).toEqual({
      PreToolUse: [
        {
          ...group,
          hooks: kind === "identical duplicates" ? [owned, user] : [user],
        },
      ],
    });
    expect(spec.scrub(result.content, paths, hash)).toEqual(result);
  });

  it("uses the recorded pre-shell-hook ZCode template to distinguish launchers", () => {
    const path = ".zcode/config.json";
    const spec = registry.get(path);
    const templates = collectPlatformTemplates("zcode");
    if (!spec || !templates)
      throw new Error("Missing ZCode templates or scrubber");
    const pristine = readFileSync(
      new URL(
        "../../src/templates/zcode/config-before-shell-hook.json",
        import.meta.url,
      ),
      "utf8",
    ).replaceAll("{{PYTHON_CMD}}", "python3");
    const paths = [...templates.keys()];
    const hash = computeHash(pristine);
    expect(spec.scrub(pristine, paths, hash).fullyEmpty).toBe(true);
    const config = JSON.parse(pristine);
    const group = config.hooks.events.SessionStart[0];
    const owned = group.hooks[0];
    const user = {
      ...owned,
      command: owned.command.replace("python3 ", "python "),
    };
    group.hooks.push(user);
    expect(
      JSON.parse(spec.scrub(JSON.stringify(config), paths, hash).content).hooks
        .events,
    ).toEqual({ SessionStart: [{ ...group, hooks: [user] }] });
  });

  it("recognizes a custom ZCode launcher only with its installation hash", () => {
    const path = ".zcode/config.json";
    const templates = collectPlatformTemplates("zcode");
    const spec = registry.get(path);
    if (!templates || !spec)
      throw new Error("Missing ZCode templates or scrubber");
    const pristine = (templates.get(path) ?? "").replace(
      /(?:python3?|py -3) /g,
      "py -3.12 ",
    );
    const installedHash = computeHash(pristine);
    const paths = [...templates.keys()];
    expect(spec.scrub(pristine, paths, installedHash).fullyEmpty).toBe(true);
    const config = JSON.parse(pristine);
    const group = config.hooks.events.SessionStart[0];
    const entry = group.hooks[0];
    const lookalike = {
      ...entry,
      command: entry.command.replace("py -3.12", "echo"),
    };
    group.hooks.push(lookalike);
    const mixed = JSON.stringify(config);
    expect(spec.scrub(mixed, paths).content).toBe(mixed);
    expect(
      JSON.parse(spec.scrub(mixed, paths, installedHash).content).hooks.events,
    ).toEqual({
      SessionStart: [{ ...group, hooks: [lookalike] }],
    });
  });

  it("preserves a user-disabled ZCode wrapper with all probed Python launchers", () => {
    const path = ".zcode/config.json";
    const templates = collectPlatformTemplates("zcode");
    const spec = registry.get(path);
    if (!templates || !spec)
      throw new Error("Missing ZCode templates or scrubber");
    for (const launcher of ["python", "python3", "py -3"]) {
      const pristine = (templates.get(path) ?? "").replace(
        /(?:python3?|py -3) /g,
        `${launcher} `,
      );
      const root = JSON.parse(pristine);
      root.hooks.enabled = false;
      expect(
        JSON.parse(
          spec.scrub(
            JSON.stringify(root),
            [...templates.keys()],
            computeHash(pristine),
          ).content,
        ),
      ).toEqual({ hooks: { enabled: false } });
    }
  });
});
