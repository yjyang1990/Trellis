import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

function requireObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function checkOptionalText(object, keys, field) {
  for (const key of keys) {
    if (object[key] !== undefined && typeof object[key] !== "string") {
      throw new Error(`${field}.${key} must be a string`);
    }
  }
}

function requireProjectPath(value, field) {
  requireText(value, field);
  if (
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\0") ||
    value.split(/[\\/]/).includes("..") ||
    !value.split(/[\\/]/).some((part) => part && part !== ".")
  ) {
    throw new Error(`${field} must be a path within the project`);
  }
}

function validateMigration(item, index) {
  const field = `migrations[${index}]`;
  requireObject(item, field);
  checkOptionalText(item, ["description", "reason"], field);
  requireProjectPath(item.from, `${field}.from`);
  if (
    item.type === "rename" ||
    item.type === "rename-dir" ||
    item.to !== undefined
  ) {
    requireProjectPath(item.to, `${field}.to`);
  }
  if (
    !["rename", "rename-dir", "delete", "safe-file-delete"].includes(item.type)
  ) {
    throw new Error(
      `${field}.type is unsupported: ${JSON.stringify(item.type)}`,
    );
  }
  if (item.type === "safe-file-delete" || item.allowed_hashes !== undefined) {
    if (
      !Array.isArray(item.allowed_hashes) ||
      !item.allowed_hashes.length ||
      !item.allowed_hashes.every(
        (hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash),
      )
    ) {
      throw new Error(
        `${field}.allowed_hashes must be a non-empty array of lowercase SHA-256 hashes`,
      );
    }
  }
}

// Used directly by pre-build release scripts and copied with the runtime manifests.
export function readMigrationManifest(file) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      fs.readFileSync(file),
    );
    const manifest = JSON.parse(text);
    requireObject(manifest, "manifest");
    const version = path.basename(file, ".json");
    requireText(manifest.version, "version");
    if (manifest.version !== version) {
      throw new Error(
        `version ${JSON.stringify(manifest.version)} does not match filename ${version}.json`,
      );
    }
    if (!Array.isArray(manifest.migrations))
      throw new Error("migrations must be an array");
    manifest.migrations.forEach(validateMigration);
    // 0.2.15 shipped structured changelog entries before changelog became a string.
    if (Array.isArray(manifest.changelog)) {
      manifest.changelog = manifest.changelog
        .map((entry, index) => {
          requireText(entry?.description, `changelog[${index}].description`);
          return entry.description;
        })
        .join("\n");
    }
    checkOptionalText(
      manifest,
      ["changelog", "description", "migrationGuide", "aiInstructions"],
      "manifest",
    );
    for (const key of ["breaking", "recommendMigrate"]) {
      if (manifest[key] !== undefined && typeof manifest[key] !== "boolean") {
        throw new Error(`${key} must be a boolean`);
      }
    }
    if (manifest.breaking && manifest.recommendMigrate) {
      requireText(manifest.migrationGuide, "migrationGuide");
      requireText(manifest.aiInstructions, "aiInstructions");
    }
    if (manifest.configSectionsAdded !== undefined) {
      if (!Array.isArray(manifest.configSectionsAdded))
        throw new Error("configSectionsAdded must be an array");
      for (const [index, section] of manifest.configSectionsAdded.entries()) {
        const field = `configSectionsAdded[${index}]`;
        requireObject(section, field);
        requireProjectPath(section.file, `${field}.file`);
        requireText(section.sentinel, `${field}.sentinel`);
        requireText(section.sectionHeading, `${field}.sectionHeading`);
      }
    }
    return manifest;
  } catch (error) {
    throw new Error(`Invalid migration manifest ${file}: ${error.message}`, {
      cause: error,
    });
  }
}
