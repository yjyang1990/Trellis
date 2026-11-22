import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createChannel,
  readChannelEvents,
  resolveChannelRef,
} from "@mindfoldhq/trellis-core/channel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cli = fileURLToPath(new URL("../../bin/trellis.js", import.meta.url));

describe("channel commands against the SDK store", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "trellis-store-")),
    );
    vi.stubEnv("TRELLIS_CHANNEL_ROOT", path.join(cwd, "channels"));
    vi.stubEnv("TRELLIS_CHANNEL_PROJECT", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function command(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, "channel", ...args], {
      cwd,
      env: { ...process.env, PATH: cwd },
      encoding: "utf8",
      timeout: 8000,
    });
    if (result.error) throw result.error;
    return result;
  }

  it("lists an SDK channel, writes to the selected scope and removes only that scope", async () => {
    const channel = "shared";
    await createChannel({ channel, cwd, by: "sdk" });
    await createChannel({ channel, cwd, by: "sdk", scope: "global" });
    const listed = command("list", "--json");
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([
      { name: channel, totalEvents: 1 },
    ]);

    const ambiguous = command("rm", channel);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain("exists in global and project scopes");
    const sent = command(
      "send",
      channel,
      "hello",
      "--as",
      "cli",
      "--scope",
      "project",
    );
    expect(sent.status).toBe(0);
    const events = await readChannelEvents({ channel, cwd, scope: "project" });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(JSON.parse(sent.stdout));
    expect(events[1]).toMatchObject({
      seq: 2,
      kind: "message",
      by: "cli",
      text: "hello",
    });

    const removed = command("rm", channel, "--scope", "project");
    expect(removed.status).toBe(0);
    expect(removed.stdout.trim()).toBe("Removed channel 'shared'");
    expect(() => resolveChannelRef({ channel, cwd, scope: "project" })).toThrow(
      "not found",
    );
    expect(await readChannelEvents({ channel, scope: "global" })).toHaveLength(
      1,
    );
  });

  it("rejects duplicate spawn and records stale supervisor cleanup in the same bucket", async () => {
    const channel = "workers";
    await createChannel({ channel, cwd, by: "sdk" });
    const { dir } = resolveChannelRef({ channel, cwd, forCreate: true });
    const pid = path.join(dir, "local.pid");
    fs.writeFileSync(pid, String(process.pid));
    const spawned = command(
      "spawn",
      channel,
      "--provider",
      "claude",
      "--as",
      "local",
      "--idle-timeout",
      "0",
      "--max-live-workers",
      "0",
    );
    expect(spawned.status).toBe(1);
    expect(spawned.stderr).toContain(
      `already running in channel '${channel}' (pid ${process.pid})`,
    );
    expect(
      fs.existsSync(path.join(path.dirname(dir), ".worker-guard.lock")),
    ).toBe(false);
    expect(fs.existsSync(path.join(dir, "local.spawnlock"))).toBe(false);

    fs.writeFileSync(pid, "0");
    const killed = command("kill", channel, "--as", "local");
    expect(killed.status).toBe(0);
    expect(fs.existsSync(pid)).toBe(false);
    expect(
      await readChannelEvents({ channel, cwd, scope: "project" }),
    ).toMatchObject([
      { kind: "create", seq: 1 },
      {
        kind: "error",
        seq: 2,
        by: "cli:kill",
        worker: "local",
        message: "supervisor lost (pid 0)",
      },
    ]);
  });

  it("retains the ephemeral channel at the reported path after run fails before spawn", async () => {
    const channel = "one-shot";
    const result = command(
      "run",
      channel,
      "--as",
      "local",
      "--message",
      "hello",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing --provider");
    const { dir } = resolveChannelRef({ channel, cwd, scope: "project" });
    expect(result.stderr).toContain(`channel kept for inspection: ${dir}\n`);
    expect(
      await readChannelEvents({ channel, cwd, scope: "project" }),
    ).toMatchObject([
      {
        kind: "create",
        seq: 1,
        ephemeral: true,
        origin: "cli",
        meta: { trellis: { createMode: "run" } },
      },
    ]);
  });
});
