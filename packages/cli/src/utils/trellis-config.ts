/** Minimal config.yaml subset shared with common/trellis_config.py. */
export interface ConfigMap {
  [key: string]: string | string[] | ConfigMap | undefined;
}

export function configMap(value: ConfigMap[string]): ConfigMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : (Object.create(null) as ConfigMap);
}

/** Keep the whitespace before a comment available to text-preserving writers. */
export function beforeConfigComment(text: string): string {
  let quote: string | undefined;
  let previous = "";
  let offset = 0;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === "#" && (!previous || /\s/.test(previous))) {
      return text.slice(0, offset);
    } else if (ch === '"' || ch === "'") {
      // A plain word may contain or end with an apostrophe.
      if (ch !== "'" || !/[\p{L}\p{N}_]/u.test(previous)) quote = ch;
    }
    previous = ch;
    offset += ch.length;
  }
  return text;
}

function configScalar(raw: string, listItem: boolean): string | undefined {
  const value = beforeConfigComment(raw).trim();
  if (listItem && /^(?:"[^"]*"|'[^']*')\s*:(?:\s|$)/.test(value))
    return undefined;
  if (
    value.length >= 2 &&
    (value[0] === '"' || value[0] === "'") &&
    value.at(-1) === value[0]
  ) {
    return value.slice(1, -1);
  }
  if (/^[&*[{]|^[|>][+\-\d]*$/.test(value)) return undefined;
  if (listItem && (!value || /:(?:\s|$)|^-(?:\s|$)/.test(value)))
    return undefined;
  return value;
}

type OnKey = (
  parent: ConfigMap,
  key: string,
  line: number,
  raw: string,
) => void;

export function parseTrellisConfig(content: string, onKey?: OnKey): ConfigMap {
  const lines = content
    .split(/\r?\n/)
    .map((text, line) => ({
      text: text.trim(),
      indent: text.length - text.trimStart().length,
      line,
    }))
    .filter(({ text }) => text && !text.startsWith("#"));
  let i = 0;
  const isItem = (text: string): boolean => /^-(?:\s|$)/.test(text);
  function skipBody(indent: number): void {
    while (i < lines.length && lines[i].indent > indent) i++;
  }
  function mapping(indent: number): ConfigMap {
    const result: ConfigMap = Object.create(null) as ConfigMap;
    while (i < lines.length && lines[i].indent >= indent) {
      const row = lines[i++];
      const colon = row.text.indexOf(":");
      if (row.indent !== indent || colon < 1 || isItem(row.text)) {
        skipBody(row.indent);
        continue;
      }
      const key = row.text.slice(0, colon).trim();
      const raw = row.text.slice(colon + 1);
      onKey?.(result, key, row.line, raw);
      if (key === "<<" || beforeConfigComment(raw).trim()) {
        const value = configScalar(raw, false);
        if (key !== "<<" && value !== undefined) result[key] = value;
        skipBody(indent);
        continue;
      }
      const next = lines[i];
      if (next && next.indent >= indent && isItem(next.text)) {
        const items: string[] = [];
        while (
          i < lines.length &&
          lines[i].indent === next.indent &&
          isItem(lines[i].text)
        ) {
          const value = configScalar(lines[i++].text.slice(1), true);
          if (
            value !== undefined &&
            !(i < lines.length && lines[i].indent > next.indent)
          ) {
            items.push(value);
          }
          skipBody(next.indent);
        }
        result[key] = items;
      } else {
        result[key] =
          next && next.indent > indent
            ? mapping(next.indent)
            : configMap(undefined);
      }
    }
    return result;
  }
  return mapping(0);
}
