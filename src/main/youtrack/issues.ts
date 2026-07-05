/* eslint-disable max-lines -- Why: YouTrack task reads and mutations share
   custom-field mapping, multi-instance fan-out, and auth-clearing behavior;
   keeping the API boundary together avoids subtle drift between operations. */
import type {
  YouTrackComment,
  YouTrackCreateIssueArgs,
  YouTrackCreateIssueResult,
  YouTrackInstance,
  YouTrackInstanceSelection,
  YouTrackIssue,
  YouTrackIssueFilter,
  YouTrackIssueUpdate,
  YouTrackMutationResult,
  YouTrackPriority,
  YouTrackProject,
  YouTrackTransition,
  YouTrackUser
} from '../../shared/types'
import {
  acquire,
  clearToken,
  getClients,
  isAuthError,
  release,
  youtrackRequest,
  type YouTrackClientForInstance
} from './client'

const ISSUE_FIELDS =
  'id,idReadable,summary,description,project(id,shortName,name),' +
  'customFields(name,value(name,login,fullName,email,avatarUrl(url),isResolved)),' +
  'tags(name),reporter(id,login,fullName,email,avatarUrl(url)),created,updated'

type YouTrackRecord = Record<string, unknown>

type YouTrackIssueSearchFailure = {
  error: unknown
  auth: boolean
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return null
  }
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function toIssueSearchFailureError(error: unknown): unknown {
  const status = getErrorStatus(error)
  if (
    status === null ||
    !(error instanceof Error) ||
    error.message.startsWith(`Error ${status}:`)
  ) {
    return error
  }
  return new Error(`Error ${status}: ${error.message}`)
}

function shouldSurfaceInstanceFailure(
  selection: YouTrackInstanceSelection | null | undefined,
  entryCount: number
): boolean {
  // getClients can resolve an omitted selection to the persisted 'all'
  // choice; multi-entry reads need the same resilient fan-out policy as an
  // explicit 'all'.
  return selection !== 'all' && entryCount <= 1
}

function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

function asRecord(value: unknown): YouTrackRecord {
  return value && typeof value === 'object' ? (value as YouTrackRecord) : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function mapUser(value: unknown): YouTrackUser | undefined {
  const user = asRecord(value)
  const id = asString(user.id)
  if (!id) {
    return undefined
  }
  const avatar = asRecord(user.avatarUrl)
  return {
    id,
    displayName: asString(user.fullName, asString(user.login, 'Unknown')),
    email: typeof user.email === 'string' ? user.email : undefined,
    avatarUrl: typeof avatar.url === 'string' ? avatar.url : undefined
  }
}

function mapProject(value: unknown, instance?: YouTrackInstance): YouTrackProject {
  const project = asRecord(value)
  return {
    id: asString(project.id),
    shortName: asString(project.shortName),
    name: asString(project.name, asString(project.shortName)),
    instanceId: instance?.id,
    instanceName: instance?.displayName
  }
}

function findCustomField(customFields: unknown, name: string): YouTrackRecord | undefined {
  if (!Array.isArray(customFields)) {
    return undefined
  }
  const field = customFields.find(
    (entry) => entry && typeof entry === 'object' && (entry as YouTrackRecord).name === name
  )
  return field ? asRecord(field) : undefined
}

function mapStatus(customFields: unknown): YouTrackIssue['status'] {
  const field = findCustomField(customFields, 'State')
  if (!field) {
    return undefined
  }
  const value = asRecord(field.value)
  const name = asString(value.name)
  if (!name) {
    return undefined
  }
  return { name, resolved: value.isResolved === true }
}

function mapPriority(customFields: unknown): YouTrackIssue['priority'] {
  const field = findCustomField(customFields, 'Priority')
  if (!field) {
    return undefined
  }
  const name = asString(asRecord(field.value).name)
  return name ? { name } : undefined
}

function mapAssignee(customFields: unknown): YouTrackUser | undefined {
  const field = findCustomField(customFields, 'Assignee')
  return field ? mapUser(field.value) : undefined
}

function issueUrl(instance: YouTrackInstance, idReadable: string): string {
  return `${instance.baseUrl}/issue/${encodeURIComponent(idReadable)}`
}

export function mapYouTrackIssue(instance: YouTrackInstance, raw: YouTrackRecord): YouTrackIssue {
  const idReadable = asString(raw.idReadable)
  return {
    id: asString(raw.id, idReadable),
    idReadable,
    instanceId: instance.id,
    instanceName: instance.displayName,
    title: asString(raw.summary, idReadable || 'Untitled issue'),
    description: asString(raw.description) || undefined,
    url: issueUrl(instance, idReadable),
    project: mapProject(raw.project, instance),
    status: mapStatus(raw.customFields),
    labels: asStringArray(Array.isArray(raw.tags) ? raw.tags.map((tag) => asRecord(tag).name) : []),
    assignee: mapAssignee(raw.customFields),
    reporter: mapUser(raw.reporter),
    priority: mapPriority(raw.customFields),
    createdAt: msToIso(raw.created),
    updatedAt: msToIso(raw.updated)
  }
}

function msToIso(value: unknown): string {
  const ms = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString()
}

function sortAndLimitIssues(issues: YouTrackIssue[], limit: number): YouTrackIssue[] {
  return issues
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

function filterToQuery(filter: YouTrackIssueFilter): string {
  if (filter === 'assigned') {
    return 'assignee: me #Unresolved'
  }
  if (filter === 'reported') {
    return 'reporter: me #Unresolved'
  }
  if (filter === 'unresolved') {
    return '#Unresolved'
  }
  return ''
}

async function searchIssuesForClient(
  entry: YouTrackClientForInstance,
  query: string,
  limit: number
): Promise<YouTrackIssue[]> {
  const params = new URLSearchParams({
    fields: ISSUE_FIELDS,
    $top: String(limit)
  })
  if (query) {
    params.set('query', query)
  }
  const result = await youtrackRequest<YouTrackRecord[]>(entry, `/issues?${params.toString()}`)
  return (result ?? []).map((issue) => mapYouTrackIssue(entry.instance, issue))
}

export async function listIssues(
  filter: YouTrackIssueFilter = 'assigned',
  limit = 30,
  instanceId?: YouTrackInstanceSelection | null
): Promise<YouTrackIssue[]> {
  return searchIssues(filterToQuery(filter), limit, instanceId)
}

export async function searchIssues(
  query: string,
  limit = 30,
  instanceId?: YouTrackInstanceSelection | null
): Promise<YouTrackIssue[]> {
  const entries = getClients(instanceId)
  if (entries.length === 0) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const failures: (YouTrackIssueSearchFailure | undefined)[] = Array.from({
    length: entries.length
  })
  const surfaceInstanceFailure = shouldSurfaceInstanceFailure(instanceId, entries.length)
  const results = await Promise.all(
    entries.map(async (entry, index) => {
      await acquire()
      try {
        return await searchIssuesForClient(entry, query.trim(), safeLimit)
      } catch (error) {
        const authFailure = isAuthError(error)
        if (authFailure) {
          clearToken(entry.instance.id)
        }
        if (surfaceInstanceFailure) {
          throw toIssueSearchFailureError(error)
        }
        console.warn('[youtrack] searchIssues failed:', error)
        failures[index] = { error: toIssueSearchFailureError(error), auth: authFailure }
        return [] as YouTrackIssue[]
      } finally {
        release()
      }
    })
  )
  // 'all' fan-out: only surface an error when every connected instance
  // failed, so a partial success (or a genuinely empty result) is not
  // reported as an error.
  const recordedFailures = failures.filter(
    (failure): failure is YouTrackIssueSearchFailure => failure !== undefined
  )
  if (recordedFailures.length === entries.length) {
    throw (recordedFailures.find((failure) => !failure.auth) ?? recordedFailures[0]).error
  }
  return entries.length === 1
    ? results.flat().slice(0, safeLimit)
    : sortAndLimitIssues(results.flat(), safeLimit)
}

export async function getIssue(
  id: string,
  instanceId?: YouTrackInstanceSelection | null
): Promise<YouTrackIssue | null> {
  const entries = getClients(instanceId)
  for (const entry of entries) {
    await acquire()
    try {
      const issue = await youtrackRequest<YouTrackRecord>(
        entry,
        `/issues/${encodeURIComponent(id)}?fields=${encodeURIComponent(ISSUE_FIELDS)}`
      )
      return mapYouTrackIssue(entry.instance, issue)
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.instance.id)
        if (shouldSurfaceInstanceFailure(instanceId, entries.length)) {
          throw error
        }
      } else {
        console.warn('[youtrack] getIssue failed:', error)
      }
    } finally {
      release()
    }
  }
  return null
}

export async function createIssue(
  args: YouTrackCreateIssueArgs
): Promise<YouTrackCreateIssueResult> {
  const entry = getClients(args.instanceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to YouTrack.' }
  }
  const title = args.title.trim()
  if (!title) {
    return { ok: false, error: 'Title is required.' }
  }

  await acquire()
  try {
    const body: YouTrackRecord = {
      project: { id: args.projectId },
      summary: title
    }
    if (args.description?.trim()) {
      body.description = args.description.trim()
    }
    const created = await youtrackRequest<{ id: string; idReadable: string }>(
      entry,
      '/issues?fields=id,idReadable',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    )
    return {
      ok: true,
      id: created.id,
      idReadable: created.idReadable,
      url: issueUrl(entry.instance, created.idReadable)
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create issue.' }
  } finally {
    release()
  }
}

export async function updateIssue(
  id: string,
  updates: YouTrackIssueUpdate,
  instanceId?: string | null
): Promise<YouTrackMutationResult> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to YouTrack.' }
  }
  await acquire()
  try {
    const body: YouTrackRecord = {}
    if (updates.title !== undefined) {
      body.summary = updates.title
    }
    if (updates.description !== undefined) {
      body.description = updates.description
    }
    const customFields: YouTrackRecord[] = []
    if (updates.assigneeId !== undefined) {
      customFields.push({
        name: 'Assignee',
        $type: 'SingleUserIssueCustomField',
        value: updates.assigneeId ? { id: updates.assigneeId } : null
      })
    }
    if (updates.stateName !== undefined) {
      customFields.push({
        name: 'State',
        $type: 'StateIssueCustomField',
        value: { name: updates.stateName }
      })
    }
    if (updates.priorityName !== undefined) {
      customFields.push({
        name: 'Priority',
        $type: 'SingleEnumIssueCustomField',
        value: updates.priorityName ? { name: updates.priorityName } : null
      })
    }
    if (customFields.length > 0) {
      body.customFields = customFields
    }
    if (Object.keys(body).length > 0) {
      await youtrackRequest(entry, `/issues/${encodeURIComponent(id)}?fields=id`, {
        method: 'POST',
        body: JSON.stringify(body)
      })
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to update issue.' }
  } finally {
    release()
  }
}

export async function addIssueComment(
  id: string,
  body: string,
  instanceId?: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to YouTrack.' }
  }
  await acquire()
  try {
    const comment = await youtrackRequest<{ id: string }>(
      entry,
      `/issues/${encodeURIComponent(id)}/comments?fields=id`,
      {
        method: 'POST',
        body: JSON.stringify({ text: body })
      }
    )
    return { ok: true, id: comment.id }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add comment.' }
  } finally {
    release()
  }
}

function mapComment(raw: YouTrackRecord): YouTrackComment {
  return {
    id: asString(raw.id),
    body: asString(raw.text),
    createdAt: msToIso(raw.created),
    updatedAt: raw.updated !== undefined ? msToIso(raw.updated) : undefined,
    user: mapUser(raw.author)
  }
}

export async function getIssueComments(
  id: string,
  instanceId?: string | null
): Promise<YouTrackComment[]> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const comments = await youtrackRequest<YouTrackRecord[]>(
      entry,
      `/issues/${encodeURIComponent(id)}/comments?fields=id,text,created,updated,author(id,login,fullName,email,avatarUrl(url))`
    )
    return (comments ?? []).map(mapComment)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    console.warn('[youtrack] getIssueComments failed:', error)
    return []
  } finally {
    release()
  }
}

export async function listProjects(
  instanceId?: YouTrackInstanceSelection | null
): Promise<YouTrackProject[]> {
  const entries = getClients(instanceId)
  if (entries.length === 0) {
    return []
  }
  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const projects = await youtrackRequest<YouTrackRecord[]>(
          entry,
          '/admin/projects?fields=id,shortName,name'
        )
        return (projects ?? []).map((project) => mapProject(project, entry.instance))
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.instance.id)
          if (shouldSurfaceInstanceFailure(instanceId, entries.length)) {
            throw error
          }
        } else {
          console.warn('[youtrack] listProjects failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listTransitions(
  id: string,
  instanceId?: string | null
): Promise<YouTrackTransition[]> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const response = await youtrackRequest<YouTrackRecord>(
      entry,
      `/issues/${encodeURIComponent(id)}?fields=customFields(name,value(name,isResolved),bundle(id))`
    )
    const customFields = Array.isArray(response.customFields) ? response.customFields : []
    const stateField = findCustomField(customFields, 'State')
    if (!stateField) {
      return []
    }
    const bundleId = asString(asRecord(stateField.bundle).id)
    if (!bundleId) {
      return []
    }
    const states = await youtrackRequest<YouTrackRecord[]>(
      entry,
      `/admin/customFieldSettings/bundles/state/${encodeURIComponent(bundleId)}/values?fields=id,name,isResolved`
    )
    return (states ?? []).map((state) => ({
      id: asString(state.id),
      name: asString(state.name),
      to: {
        name: asString(state.name),
        resolved: state.isResolved === true
      }
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    console.warn('[youtrack] listTransitions failed:', error)
    return []
  } finally {
    release()
  }
}

export async function listPriorities(instanceId?: string | null): Promise<YouTrackPriority[]> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const response = await youtrackRequest<YouTrackRecord[]>(
      entry,
      `/issues?fields=customFields(name,bundle(id))&$top=1`
    )
    const issues = Array.isArray(response) ? response : [response]
    const firstIssue = issues[0]
    const customFields = Array.isArray(firstIssue?.customFields) ? firstIssue.customFields : []
    const priorityField = findCustomField(customFields, 'Priority')
    if (!priorityField) {
      return []
    }
    const bundleId = asString(asRecord(priorityField.bundle).id)
    if (!bundleId) {
      return []
    }
    const priorities = await youtrackRequest<YouTrackRecord[]>(
      entry,
      `/admin/customFieldSettings/bundles/enum/${encodeURIComponent(bundleId)}/values?fields=id,name`
    )
    return (priorities ?? []).map((priority) => ({
      name: asString(priority.name)
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    console.warn('[youtrack] listPriorities failed:', error)
    return []
  } finally {
    release()
  }
}

export async function listAssignableUsers(
  id: string,
  instanceId?: string | null
): Promise<YouTrackUser[]> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const issue = await youtrackRequest<YouTrackRecord>(
      entry,
      `/issues/${encodeURIComponent(id)}?fields=project(id)`
    )
    const projectId = asString(asRecord(issue.project).id)
    if (!projectId) {
      return []
    }
    const customFields = await youtrackRequest<YouTrackRecord[]>(
      entry,
      `/admin/projects/${encodeURIComponent(projectId)}/customFields?fields=name,bundle(id)`
    )
    const customFieldsArray = Array.isArray(customFields) ? customFields : []
    const assigneeField = customFieldsArray.find(
      (field) => field && typeof field === 'object' && (field as YouTrackRecord).name === 'Assignee'
    )
    if (!assigneeField) {
      return []
    }
    const bundleId = asString(asRecord(assigneeField.bundle).id)
    if (!bundleId) {
      return []
    }
    const result = await youtrackRequest<YouTrackRecord[]>(
      entry,
      `/admin/customFieldSettings/bundles/user/${encodeURIComponent(bundleId)}/values?fields=id,login,fullName,email,avatarUrl(url)`
    )
    return (result ?? []).map(mapUser).filter((user): user is YouTrackUser => !!user)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    console.warn('[youtrack] listAssignableUsers failed:', error)
    return []
  } finally {
    release()
  }
}

export async function listIssueTags(
  id: string,
  instanceId?: string | null
): Promise<YouTrackUser[]> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const tags = await youtrackRequest<YouTrackRecord[]>(
      entry,
      `/issueTags?query=${encodeURIComponent(`issue:${id}`)}&fields=id,name`
    )
    return (tags ?? []).map((tag) => ({
      id: asString(tag.id),
      displayName: asString(tag.name)
    })) as YouTrackUser[]
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    console.warn('[youtrack] listIssueTags failed:', error)
    return []
  } finally {
    release()
  }
}

export async function addIssueTag(
  issueId: string,
  tagId: string,
  instanceId?: string | null
): Promise<YouTrackMutationResult> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to YouTrack.' }
  }
  await acquire()
  try {
    await youtrackRequest(entry, `/issues/${encodeURIComponent(issueId)}/tags`, {
      method: 'POST',
      body: JSON.stringify({ id: tagId })
    })
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add tag.' }
  } finally {
    release()
  }
}

export async function removeIssueTag(
  issueId: string,
  tagId: string,
  instanceId?: string | null
): Promise<YouTrackMutationResult> {
  const entry = getClients(instanceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to YouTrack.' }
  }
  await acquire()
  try {
    await youtrackRequest(
      entry,
      `/issues/${encodeURIComponent(issueId)}/tags/${encodeURIComponent(tagId)}`,
      {
        method: 'DELETE'
      }
    )
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.instance.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to remove tag.' }
  } finally {
    release()
  }
}
