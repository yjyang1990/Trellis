import {
  resolveChannelRef,
  type ChannelRef,
  type ChannelScope,
} from "@mindfoldhq/trellis-core/channel";

export {
  assertSafeName,
  channelDir,
  channelRoot,
  currentProjectKey,
  eventsPath,
  isSafeName,
  listProjects,
  migrateLegacyChannels,
  projectDir,
  projectKey,
  workerFile,
  workerLockPath,
} from "@mindfoldhq/trellis-core/channel";

export interface ResolveChannelOptions {
  scope?: ChannelScope;
  cwd?: string;
}

export function resolveExistingChannelRef(
  name: string,
  opts: ResolveChannelOptions = {},
): ChannelRef {
  return resolveChannelRef({ channel: name, scope: opts.scope, cwd: opts.cwd });
}
