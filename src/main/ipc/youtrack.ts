import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectInstance, testConnection } from '../youtrack/client'
import { _resetPreflightCache } from './preflight'
import {
  addIssueComment,
  createIssue,
  getIssue,
  getIssueComments,
  listProjects,
  searchIssues,
  listIssues,
  updateIssue
} from '../youtrack/issues'
import type {
  YouTrackConnectArgs,
  YouTrackCreateIssueArgs,
  YouTrackInstanceSelection,
  YouTrackIssueFilter,
  YouTrackIssueUpdate
} from '../../shared/types'

const VALID_FILTERS = new Set<YouTrackIssueFilter>(['assigned', 'reported', 'all', 'unresolved'])

function normalizeInstanceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeInstanceSelection(value: unknown): YouTrackInstanceSelection | undefined {
  const instanceId = normalizeInstanceId(value)
  return instanceId as YouTrackInstanceSelection | undefined
}

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function normalizeIssueUpdate(value: unknown): YouTrackIssueUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as YouTrackIssueUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    return null
  }
  if (
    input.assigneeId !== undefined &&
    input.assigneeId !== null &&
    typeof input.assigneeId !== 'string'
  ) {
    return null
  }
  if (input.stateName !== undefined && typeof input.stateName !== 'string') {
    return null
  }
  if (input.priorityName !== undefined && typeof input.priorityName !== 'string') {
    return null
  }
  return input
}

export function registerYouTrackHandlers(): void {
  ipcMain.handle('youtrack:connect', async (_event, args: YouTrackConnectArgs) => {
    if (typeof args?.baseUrl !== 'string' || typeof args?.token !== 'string') {
      return { ok: false, error: 'URL and permanent token are required.' }
    }
    const result = await connect({ baseUrl: args.baseUrl, token: args.token })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('youtrack:disconnect', async (_event, args?: { instanceId?: string }) => {
    disconnect(normalizeInstanceId(args?.instanceId))
    _resetPreflightCache()
  })

  ipcMain.handle(
    'youtrack:selectInstance',
    async (_event, args: { instanceId: YouTrackInstanceSelection }) => {
      const instanceId = normalizeInstanceSelection(args?.instanceId)
      if (!instanceId) {
        return getStatus()
      }
      return selectInstance(instanceId)
    }
  )

  ipcMain.handle('youtrack:status', async () => {
    return getStatus()
  })

  ipcMain.handle('youtrack:testConnection', async (_event, args?: { instanceId?: string }) => {
    return testConnection(normalizeInstanceId(args?.instanceId))
  })

  ipcMain.handle(
    'youtrack:searchIssues',
    async (
      _event,
      args: { query: string; limit?: number; instanceId?: YouTrackInstanceSelection }
    ) => {
      if (typeof args?.query !== 'string') {
        return []
      }
      return searchIssues(
        args.query,
        clampLimit(args.limit),
        normalizeInstanceSelection(args.instanceId)
      )
    }
  )

  ipcMain.handle(
    'youtrack:listIssues',
    async (
      _event,
      args?: {
        filter?: YouTrackIssueFilter
        limit?: number
        instanceId?: YouTrackInstanceSelection
      }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as YouTrackIssueFilter)
        ? (args!.filter as YouTrackIssueFilter)
        : undefined
      return listIssues(
        filter,
        clampLimit(args?.limit),
        normalizeInstanceSelection(args?.instanceId)
      )
    }
  )

  ipcMain.handle('youtrack:getIssue', async (_event, args: { id: string; instanceId?: string }) => {
    if (typeof args?.id !== 'string' || !args.id.trim()) {
      return null
    }
    return getIssue(args.id.trim(), normalizeInstanceId(args.instanceId))
  })

  ipcMain.handle('youtrack:createIssue', async (_event, args: YouTrackCreateIssueArgs) => {
    if (typeof args?.projectId !== 'string' || !args.projectId.trim()) {
      return { ok: false, error: 'Project is required.' }
    }
    if (typeof args?.title !== 'string' || !args.title.trim()) {
      return { ok: false, error: 'Title is required.' }
    }
    return createIssue({
      instanceId: normalizeInstanceId(args.instanceId),
      projectId: args.projectId.trim(),
      title: args.title.trim(),
      description: args.description?.trim() || undefined
    })
  })

  ipcMain.handle(
    'youtrack:updateIssue',
    async (_event, args: { id: string; updates: YouTrackIssueUpdate; instanceId?: string }) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        return { ok: false, error: 'Issue id is required.' }
      }
      const updates = normalizeIssueUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateIssue(args.id.trim(), updates, normalizeInstanceId(args.instanceId))
    }
  )

  ipcMain.handle(
    'youtrack:addIssueComment',
    async (_event, args: { id: string; body: string; instanceId?: string }) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        return { ok: false, error: 'Issue id is required.' }
      }
      if (typeof args?.body !== 'string' || !args.body.trim()) {
        return { ok: false, error: 'Comment body is required.' }
      }
      return addIssueComment(args.id.trim(), args.body.trim(), normalizeInstanceId(args.instanceId))
    }
  )

  ipcMain.handle(
    'youtrack:issueComments',
    async (_event, args: { id: string; instanceId?: string }) => {
      if (typeof args?.id !== 'string' || !args.id.trim()) {
        return []
      }
      return getIssueComments(args.id.trim(), normalizeInstanceId(args.instanceId))
    }
  )

  ipcMain.handle(
    'youtrack:listProjects',
    async (_event, args?: { instanceId?: YouTrackInstanceSelection }) => {
      return listProjects(normalizeInstanceSelection(args?.instanceId))
    }
  )
}
