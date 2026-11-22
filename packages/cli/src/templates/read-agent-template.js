import { readFileSync } from "node:fs";
import { URL } from "node:url";

// A platform may replace its entire Markdown body with one shared-body reference.
// Packaged agent files already contain the body and pass through verbatim.
export function readAgentTemplate(filePath) {
  const content = readFileSync(filePath, "utf-8");
  return content.replace(
    /(?<=\n)\{\{AGENT_BODY:([a-z-]+)\}\}\r?\n?$/,
    (_, name) =>
      readFileSync(
        new URL(`./common/agent-bodies/${name}.md`, import.meta.url),
        "utf-8",
      ),
  );
}
