import type {
  GlobalSettings,
  YouTrackComment,
  YouTrackConnectionStatus,
  YouTrackCreateIssueArgs,
  YouTrackCreateIssueResult,
  YouTrackInstanceSelection,
  YouTrackIssue,
  YouTrackIssueFilter,
  YouTrackIssueUpdate,
  YouTrackMutationResult,
  YouTrackPriority,
  YouTrackProject,
  YouTrackTransition,
  YouTrackUser,
  YouTrackViewer
} from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'

export type RuntimeYouTrackSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

export type YouTrackConnectResult =
  | { ok: true; viewer: YouTrackViewer }
  | { ok: false; error: string }
export type YouTrackCommentResult = { ok: true; id: string } | { ok: false; error: string }

function isTaskSourceRuntimeSettings(
  settings: RuntimeYouTrackSettings
): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

function getYouTrackRuntimeTarget(
  settings: RuntimeYouTrackSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  // Why: task source context makes provider ownership explicit; legacy callers
  // still pass focused runtime settings until Tasks finishes migrating.
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

export async function youtrackStatus(
  settings: RuntimeYouTrackSettings
): Promise<YouTrackConnectionStatus> {
  const target = getYouTrackRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackConnectionStatus>(target, 'youtrack.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.youtrack.status()
}

export async function youtrackConnect(
  settings: RuntimeYouTrackSettings,
  args: { baseUrl: string; token: string }
): Promise<YouTrackConnectResult> {
  const target = getYouTrackRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackConnectResult>(target, 'youtrack.connect', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.connect(args)
}

export async function youtrackDisconnect(
  settings: RuntimeYouTrackSettings,
  instanceId?: string | null
): Promise<void> {
  const target = getYouTrackRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(
      target,
      'youtrack.disconnect',
      instanceId ? { instanceId } : undefined,
      { timeoutMs: 15_000 }
    )
    return
  }
  await window.api.youtrack.disconnect(instanceId ? { instanceId } : undefined)
}

export async function youtrackSelectInstance(
  settings: RuntimeYouTrackSettings,
  instanceId: YouTrackInstanceSelection
): Promise<YouTrackConnectionStatus> {
  const target = getYouTrackRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackConnectionStatus>(
        target,
        'youtrack.selectInstance',
        { instanceId },
        { timeoutMs: 15_000 }
      )
    : window.api.youtrack.selectInstance({ instanceId })
}

export async function youtrackTestConnection(
  settings: RuntimeYouTrackSettings,
  instanceId?: string | null
): Promise<YouTrackConnectResult> {
  const target = getYouTrackRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackConnectResult>(
        target,
        'youtrack.testConnection',
        instanceId ? { instanceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.youtrack.testConnection(instanceId ? { instanceId } : undefined)
}

export async function youtrackSearchIssues(
  settings: RuntimeYouTrackSettings,
  query: string,
  limit?: number,
  instanceId?: YouTrackInstanceSelection | null
): Promise<YouTrackIssue[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getYouTrackRuntimeTarget(settings)
  const args = { query, limit, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackIssue[]>(target, 'youtrack.searchIssues', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.searchIssues(args)
}

export async function youtrackListIssues(
  settings: RuntimeYouTrackSettings,
  filter?: YouTrackIssueFilter,
  limit?: number,
  instanceId?: YouTrackInstanceSelection | null
): Promise<YouTrackIssue[]> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { filter, limit, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackIssue[]>(target, 'youtrack.listIssues', args, { timeoutMs: 30_000 })
    : window.api.youtrack.listIssues(args)
}

export async function youtrackGetIssue(
  settings: RuntimeYouTrackSettings,
  id: string,
  instanceId?: string | null
): Promise<YouTrackIssue | null> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { id, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackIssue | null>(target, 'youtrack.getIssue', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.getIssue(args)
}

export async function youtrackCreateIssue(
  settings: RuntimeYouTrackSettings,
  args: YouTrackCreateIssueArgs
): Promise<YouTrackCreateIssueResult> {
  const target = getYouTrackRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackCreateIssueResult>(target, 'youtrack.createIssue', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.createIssue(args)
}

export async function youtrackUpdateIssue(
  settings: RuntimeYouTrackSettings,
  id: string,
  updates: YouTrackIssueUpdate,
  instanceId?: string | null
): Promise<YouTrackMutationResult> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { id, updates, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackMutationResult>(target, 'youtrack.updateIssue', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.updateIssue(args)
}

export async function youtrackAddIssueComment(
  settings: RuntimeYouTrackSettings,
  id: string,
  body: string,
  instanceId?: string | null
): Promise<YouTrackCommentResult> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { id, body, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackCommentResult>(target, 'youtrack.addIssueComment', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.addIssueComment(args)
}

export async function youtrackIssueComments(
  settings: RuntimeYouTrackSettings,
  id: string,
  instanceId?: string | null
): Promise<YouTrackComment[]> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { id, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackComment[]>(target, 'youtrack.issueComments', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.issueComments(args)
}

export async function youtrackListProjects(
  settings: RuntimeYouTrackSettings,
  instanceId?: YouTrackInstanceSelection | null
): Promise<YouTrackProject[]> {
  const target = getYouTrackRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackProject[]>(
        target,
        'youtrack.listProjects',
        instanceId ? { instanceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.youtrack.listProjects(instanceId ? { instanceId } : undefined)
}

export async function youtrackListTransitions(
  settings: RuntimeYouTrackSettings,
  id: string,
  instanceId?: string | null
): Promise<YouTrackTransition[]> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { id, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackTransition[]>(target, 'youtrack.listTransitions', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.listTransitions(args)
}

export async function youtrackListPriorities(
  settings: RuntimeYouTrackSettings,
  instanceId?: string | null
): Promise<YouTrackPriority[]> {
  const target = getYouTrackRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackPriority[]>(
        target,
        'youtrack.listPriorities',
        instanceId ? { instanceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.youtrack.listPriorities(instanceId ? { instanceId } : undefined)
}

export async function youtrackListAssignableUsers(
  settings: RuntimeYouTrackSettings,
  id: string,
  instanceId?: string | null
): Promise<YouTrackUser[]> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { id, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackUser[]>(target, 'youtrack.listAssignableUsers', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.listAssignableUsers(args)
}

export async function youtrackListIssueTags(
  settings: RuntimeYouTrackSettings,
  id: string,
  instanceId?: string | null
): Promise<YouTrackUser[]> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { id, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackUser[]>(target, 'youtrack.listIssueTags', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.listIssueTags(args)
}

export async function youtrackAddIssueTag(
  settings: RuntimeYouTrackSettings,
  issueId: string,
  tagId: string,
  instanceId?: string | null
): Promise<YouTrackMutationResult> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { issueId, tagId, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackMutationResult>(target, 'youtrack.addIssueTag', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.addIssueTag(args)
}

export async function youtrackRemoveIssueTag(
  settings: RuntimeYouTrackSettings,
  issueId: string,
  tagId: string,
  instanceId?: string | null
): Promise<YouTrackMutationResult> {
  const target = getYouTrackRuntimeTarget(settings)
  const args = { issueId, tagId, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<YouTrackMutationResult>(target, 'youtrack.removeIssueTag', args, {
        timeoutMs: 30_000
      })
    : window.api.youtrack.removeIssueTag(args)
}
