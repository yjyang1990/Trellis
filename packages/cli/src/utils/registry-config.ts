import fs from "node:fs";
import path from "node:path";

import { DIR_NAMES } from "../constants/paths.js";
import { writeFileAtomic } from "./atomic-write.js";
import { toPosix } from "./posix.js";
import {
  beforeConfigComment,
  configMap,
  parseTrellisConfig,
  type ConfigMap,
} from "./trellis-config.js";

export interface SpecRegistryConfig {
  source: string;
  template?: string;
}

function configPath(cwd: string): string {
  return path.join(cwd, DIR_NAMES.WORKFLOW, "config.yaml");
}

export function loadSpecRegistryConfig(cwd: string): SpecRegistryConfig | null {
  const filePath = configPath(cwd);
  if (!fs.existsSync(filePath)) return null;
  const config = parseTrellisConfig(fs.readFileSync(filePath, "utf-8"));
  const { source, template } = configMap(configMap(config.registry).spec);
  if (typeof source !== "string" || !source) return null;
  return {
    source,
    ...(typeof template === "string" && template ? { template } : {}),
  };
}

function registryScalar(value: string): string {
  if (/[\r\n]/.test(value))
    throw new Error("Registry values must fit on one config line");
  if (
    !value ||
    /^\s|\s$|^[&*[{|'">]/.test(value) ||
    beforeConfigComment(`${value} #`) !== `${value} `
  ) {
    for (const quote of ['"', "'"]) {
      const encoded = `${quote}${value}${quote}`;
      if (beforeConfigComment(`${encoded} #`).trimEnd() === encoded)
        return encoded;
    }
    throw new Error(
      "Cannot represent registry value with the supported config quoting rules",
    );
  }
  return value;
}

export function withSpecRegistryConfig(
  content: string,
  config: SpecRegistryConfig,
): string {
  const lines = content.split(/\r?\n/);
  const endings = content.match(/\r?\n/g) ?? [];
  const newline = endings[0] ?? "\n";
  const entries = new Map<ConfigMap, Map<string, number[]>>();
  const root = parseTrellisConfig(content, (parent, key, line) => {
    const keys = entries.get(parent) ?? new Map<string, number[]>();
    const occurrences = keys.get(key) ?? [];
    occurrences.push(line);
    keys.set(key, occurrences);
    entries.set(parent, keys);
  });
  function fieldLine(parent: ConfigMap, key: string): number | undefined {
    const matches = entries.get(parent)?.get(key);
    if (matches && matches.length > 1)
      throw new Error(`Cannot update registry config: duplicate ${key} key`);
    return matches?.[0];
  }
  const indent = (line: number): string => lines[line].match(/^\s*/)?.[0] ?? "";
  const source = registryScalar(config.source);
  const template = config.template
    ? registryScalar(config.template)
    : undefined;
  const registryLine = fieldLine(root, "registry");
  if (registryLine === undefined) {
    return (
      content +
      (content.endsWith("\n") ? "" : newline) +
      [
        "",
        "#-------------------------------------------------------------------------------",
        "# Registry",
        "#-------------------------------------------------------------------------------",
        "",
        "# Source used to install .trellis/spec. trellis update refreshes this",
        "# hash-tracked spec template while preserving local edits through the",
        "# normal update conflict flow.",
        "registry:",
        "  spec:",
        `    source: ${source}`,
        ...(template ? [`    template: ${template}`] : []),
        "",
      ].join(newline)
    );
  }

  // Add missing fields immediately below the appropriate header. Existing
  // fields are edited in place so comments and unrelated subtrees stay put.
  const registry = configMap(root.registry);
  const spec = configMap(registry.spec);
  const specLine = fieldLine(registry, "spec");
  const childLine = entries.get(registry)?.values().next().value?.[0];
  const firstField = entries.get(spec)?.values().next().value?.[0];
  const specIndent = childLine === undefined ? "  " : indent(childLine);
  const fieldIndent =
    firstField === undefined ? specIndent + specIndent : indent(firstField);
  const insert = specLine === undefined ? [`${specIndent}spec:`] : [];
  const remove = new Set<number>();
  for (const [key, value] of [
    ["source", source],
    ["template", template],
  ] as const) {
    const line = fieldLine(spec, key);
    if (line === undefined) {
      if (value !== undefined) insert.push(`${fieldIndent}${key}: ${value}`);
      continue;
    }
    if (typeof spec[key] !== "string") {
      throw new Error(`Cannot update registry.spec.${key}: expected a scalar`);
    }
    const colon = lines[line].indexOf(":") + 1;
    const raw = lines[line].slice(colon);
    const comment = raw.slice(beforeConfigComment(raw).trimEnd().length);
    if (value !== undefined) {
      lines[line] = `${lines[line].slice(0, colon)} ${value}${comment}`;
    } else if (comment.trimStart().startsWith("#")) {
      lines[line] = indent(line) + comment.trimStart();
    } else {
      remove.add(line);
    }
  }
  const header = specLine ?? registryLine;
  for (const [line, name, value] of [
    [registryLine, "registry", root.registry],
    [specLine, "registry.spec", registry.spec],
  ] as const) {
    if (
      line !== undefined &&
      (value === undefined || typeof value === "string" || Array.isArray(value))
    ) {
      throw new Error(`Cannot update ${name}: expected an indented mapping`);
    }
  }
  if (insert.length) {
    const separator = endings[header] ?? newline;
    lines[header] += separator + insert.join(separator);
  }
  // Deleting an unterminated last field also deletes its leading separator.
  if (remove.has(lines.length - 1)) endings.pop();
  return lines
    .map((text, i) => (remove.has(i) ? "" : text + (endings[i] ?? "")))
    .join("");
}

export function writeSpecRegistryConfig(
  cwd: string,
  config: SpecRegistryConfig,
): void {
  const filePath = configPath(cwd);
  if (!fs.existsSync(filePath)) return;
  writeFileAtomic(
    filePath,
    withSpecRegistryConfig(fs.readFileSync(filePath, "utf-8"), {
      ...config,
      source: toPosix(config.source),
    }),
  );
}
