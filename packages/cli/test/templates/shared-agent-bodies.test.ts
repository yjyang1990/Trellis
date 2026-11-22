import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAllAgents as claude } from "../../src/templates/claude/index.js";
import { getAllAgents as codebuddy } from "../../src/templates/codebuddy/index.js";
import { getAllAgents as cursor } from "../../src/templates/cursor/index.js";
import { getAllDroids as droid } from "../../src/templates/droid/index.js";
import { getAllAgents as gemini } from "../../src/templates/gemini/index.js";
import { getAllAgents as qoder } from "../../src/templates/qoder/index.js";
import { getAllAgents as trae } from "../../src/templates/trae/index.js";

const groups = {
  "hook-implement": { claude, cursor, codebuddy },
  "hook-check": { claude, cursor, codebuddy },
  "pull-implement": { gemini, qoder, trae },
  "pull-check": { gemini, qoder, trae },
  research: { claude, cursor, codebuddy, droid, gemini, qoder },
};

for (const [body, hosts] of Object.entries(groups)) {
  describe(body, () => {
    const role = body.split("-").at(-1);
    for (const [host, agents] of Object.entries(hosts)) {
      it(`preserves ${host} frontmatter and renders the shared body verbatim`, () => {
        const root = new URL("../../src/templates/", import.meta.url);
        const filename = `trellis-${role}.md`;
        const dir = host === "droid" ? "droids" : "agents";
        const source = readFileSync(
          new URL(`${host}/${dir}/${filename}`, root),
          "utf8",
        );
        const header = source.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n/)?.[0];
        expect(header).toContain(`name: trellis-${role}`);
        expect(source).toBe(`${header}{{AGENT_BODY:${body}}}\n`);
        const shared = readFileSync(
          new URL(`common/agent-bodies/${body}.md`, root),
          "utf8",
        );
        const agent = agents().find(({ name }) => name === `trellis-${role}`);
        expect(agent?.content).toBe(`${header}${shared}`);
      });
    }
  });
}
