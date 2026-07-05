/* eslint-disable max-lines -- Why: the YouTrack slice owns instance status,
   issue caches, and optimistic patch propagation as one store boundary so
   active instance changes invalidate every related query coherently. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  YouTrackConnectionStatus,
  YouTrackInstanceSelection,
  YouTrackIssue,
  YouTrackIssueFilter,
  YouTrackViewer
} from '../../../../shared/types'
import type { CacheEntry } from './github'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import {
  youtrackConnect,
  youtrackDisconnect,
  youtrackGetIssue,
  youtrackListIssues,
  youtrackSearchIssues,
  youtrackSelectInstance,
  youtrackStatus,
  youtrackTestConnection
} from '@/runtime/runtime-youtrack-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 500

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

function evictStaleEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys.sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
  const pruned: Record<string, CacheEntry<T>> = {}
  for (const key of sorted.slice(sorted.length - maxEntries)) {
    pruned[key] = cache[key]
  }
  return pruned
}

function looksLikeAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  // Why: YouTrack 403 commonly means project access is denied while the
  // saved token is still valid; do not flip Settings back to disconnected.
  return /authenticat|unauthorized|401/i.test(msg)
}

type InflightYouTrackReadRequest<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
}

type YouTrackReadOptions = { sourceContext?: TaskSourceContext | null }
type YouTrackPatchOptions = { sourceContext?: TaskSourceContext | null }

type YouTrackReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

const inflightIssueRequests = new Map<string, InflightYouTrackReadRequest<YouTrackIssue | null>>()
const inflightSearchRequests = new Map<string, InflightYouTrackReadRequest<YouTrackIssue[]>>()
const inflightListRequests = new Map<string, InflightYouTrackReadRequest<YouTrackIssue[]>>()
let youtrackStatusReadGeneration = 0
let youtrackMutationGeneration = 0

function getSelectedInstanceId(status: YouTrackConnectionStatus): YouTrackInstanceSelection | null {
  return status.selectedInstanceId ?? status.activeInstanceId ?? null
}

function shouldRefreshStatusAfterRead(
  instanceId: YouTrackInstanceSelection | null | undefined,
  status: YouTrackConnectionStatus
): boolean {
  // Why: 'all' reads can hide per-instance decrypt failures, and a visible
  // credential error may have been cleared by a successful credential read.
  return instanceId === 'all' || status.credentialError !== undefined
}

function clearYouTrackInflight(): void {
  inflightIssueRequests.clear()
  inflightSearchRequests.clear()
  inflightListRequests.clear()
}

function beginYouTrackMutation(): number {
  youtrackMutationGeneration += 1
  return youtrackMutationGeneration
}

function isCurrentYouTrackMutation(generation: number): boolean {
  return generation === youtrackMutationGeneration
}

function isCurrentYouTrackRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

function canWriteYouTrackReadResult(
  contextKey: string,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    mutationGeneration === youtrackMutationGeneration &&
    (explicitSource || isCurrentYouTrackRuntimeContext(contextKey, settings))
  )
}

function getYouTrackReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): YouTrackReadScope {
  if (!sourceContext) {
    return {
      settings,
      contextKey: getProviderRuntimeContextKey(settings),
      cachePrefix: null,
      explicitSource: false
    }
  }
  const runtimeSettings = getTaskSourceRuntimeSettings(sourceContext)
  return {
    settings: sourceContext,
    contextKey: `${getProviderRuntimeContextKey(runtimeSettings)}::${getTaskSourceCacheScope(sourceContext)}`,
    cachePrefix: getTaskSourceCacheScope(sourceContext),
    explicitSource: true
  }
}

function scopedYouTrackCacheKey(scope: YouTrackReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

export type YouTrackSlice = {
  youtrackStatus: YouTrackConnectionStatus
  youtrackStatusChecked: boolean
  youtrackStatusContextKey: string | null
  youtrackIssueCache: Record<string, CacheEntry<YouTrackIssue>>
  youtrackSearchCache: Record<string, CacheEntry<YouTrackIssue[]>>

  checkYouTrackConnection: () => Promise<void>
  connectYouTrack: (args: {
    baseUrl: string
    token: string
  }) => Promise<{ ok: true; viewer: YouTrackViewer } | { ok: false; error: string }>
  testYouTrackConnection: (
    instanceId?: string | null
  ) => Promise<{ ok: true; viewer: YouTrackViewer } | { ok: false; error: string }>
  selectYouTrackInstance: (instanceId: YouTrackInstanceSelection) => Promise<void>
  disconnectYouTrack: (instanceId?: string | null) => Promise<void>
  fetchYouTrackIssue: (
    id: string,
    instanceId?: string | null,
    options?: YouTrackReadOptions
  ) => Promise<YouTrackIssue | null>
  searchYouTrackIssues: (
    query: string,
    limit?: number,
    options?: YouTrackReadOptions
  ) => Promise<YouTrackIssue[]>
  listYouTrackIssues: (
    filter?: YouTrackIssueFilter,
    limit?: number,
    options?: YouTrackReadOptions
  ) => Promise<YouTrackIssue[]>
  patchYouTrackIssue: (
    issueId: string,
    patch: Partial<YouTrackIssue>,
    options?: YouTrackPatchOptions
  ) => void
}

export const createYouTrackSlice: StateCreator<AppState, [], [], YouTrackSlice> = (set, get) => ({
  youtrackStatus: { connected: false, viewer: null },
  youtrackStatusChecked: false,
  youtrackStatusContextKey: null,
  youtrackIssueCache: {},
  youtrackSearchCache: {},

  checkYouTrackConnection: async () => {
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const statusReadGeneration = (youtrackStatusReadGeneration += 1)
    const mutationGeneration = youtrackMutationGeneration
    if (get().youtrackStatusContextKey !== contextKey) {
      set({ youtrackStatusChecked: false })
    }
    try {
      const status = await youtrackStatus(get().settings)
      if (
        mutationGeneration !== youtrackMutationGeneration ||
        statusReadGeneration !== youtrackStatusReadGeneration ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      const prev = get().youtrackStatus
      if (
        prev.connected !== status.connected ||
        prev.credentialError !== status.credentialError ||
        prev.viewer?.id !== status.viewer?.id ||
        getSelectedInstanceId(prev) !== getSelectedInstanceId(status) ||
        (prev.instances?.length ?? 0) !== (status.instances?.length ?? 0)
      ) {
        set({
          youtrackStatus: status,
          youtrackStatusChecked: true,
          youtrackStatusContextKey: contextKey
        })
      } else if (!get().youtrackStatusChecked) {
        set({ youtrackStatusChecked: true, youtrackStatusContextKey: contextKey })
      } else if (get().youtrackStatusContextKey !== contextKey) {
        set({ youtrackStatusContextKey: contextKey })
      }
    } catch {
      if (
        mutationGeneration !== youtrackMutationGeneration ||
        statusReadGeneration !== youtrackStatusReadGeneration ||
        getProviderRuntimeContextKey(get().settings) !== contextKey
      ) {
        return
      }
      if (get().youtrackStatus.connected) {
        set({
          youtrackStatus: { connected: false, viewer: null },
          youtrackStatusChecked: true,
          youtrackStatusContextKey: contextKey
        })
      } else if (!get().youtrackStatusChecked) {
        set({ youtrackStatusChecked: true, youtrackStatusContextKey: contextKey })
      } else if (get().youtrackStatusContextKey !== contextKey) {
        set({ youtrackStatusContextKey: contextKey })
      }
    }
  },

  connectYouTrack: async (args) => {
    const requestGeneration = beginYouTrackMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    try {
      const result = await youtrackConnect(get().settings, args)
      if (
        result.ok &&
        isCurrentYouTrackMutation(requestGeneration) &&
        isCurrentYouTrackRuntimeContext(contextKey, get().settings)
      ) {
        set({
          youtrackStatus: { connected: true, viewer: result.viewer },
          youtrackStatusChecked: true,
          youtrackStatusContextKey: contextKey
        })
        void get().checkYouTrackConnection()
      } else if (result.ok) {
        return {
          ok: false as const,
          error: translate(
            'auto.store.slices.youtrack.connectionSuperseded',
            'YouTrack connection was superseded by a newer request.'
          )
        }
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      return { ok: false as const, error: message }
    }
  },

  testYouTrackConnection: async (instanceId) => {
    const requestGeneration = beginYouTrackMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    try {
      const result = await youtrackTestConnection(get().settings, instanceId)
      if (
        !isCurrentYouTrackMutation(requestGeneration) ||
        !isCurrentYouTrackRuntimeContext(contextKey, get().settings)
      ) {
        return result
      }
      const status = await youtrackStatus(get().settings)
      if (
        isCurrentYouTrackMutation(requestGeneration) &&
        isCurrentYouTrackRuntimeContext(contextKey, get().settings)
      ) {
        set({
          youtrackStatus: status,
          youtrackStatusChecked: true,
          youtrackStatusContextKey: contextKey
        })
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed'
      return { ok: false as const, error: message }
    }
  },

  selectYouTrackInstance: async (instanceId) => {
    const requestGeneration = beginYouTrackMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    const status = await youtrackSelectInstance(get().settings, instanceId)
    if (
      !isCurrentYouTrackMutation(requestGeneration) ||
      getProviderRuntimeContextKey(get().settings) !== contextKey
    ) {
      return
    }
    clearYouTrackInflight()
    set({
      youtrackStatus: status,
      youtrackIssueCache: {},
      youtrackSearchCache: {},
      youtrackStatusChecked: true,
      youtrackStatusContextKey: contextKey
    })
  },

  disconnectYouTrack: async (instanceId) => {
    const requestGeneration = beginYouTrackMutation()
    const contextKey = getProviderRuntimeContextKey(get().settings)
    await youtrackDisconnect(get().settings, instanceId)
    if (
      !isCurrentYouTrackMutation(requestGeneration) ||
      !isCurrentYouTrackRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    clearYouTrackInflight()
    const status = await youtrackStatus(get().settings)
    if (
      !isCurrentYouTrackMutation(requestGeneration) ||
      !isCurrentYouTrackRuntimeContext(contextKey, get().settings)
    ) {
      return
    }
    set({
      youtrackStatus: status.connected ? status : { connected: false, viewer: null },
      youtrackIssueCache: {},
      youtrackSearchCache: {},
      youtrackStatusChecked: true,
      youtrackStatusContextKey: contextKey
    })
  },

  fetchYouTrackIssue: async (id, instanceId, options) => {
    const scope = getYouTrackReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const issueCacheKey = scopedYouTrackCacheKey(scope, `${instanceId ?? 'selected'}::${id}`)
    const cached = get().youtrackIssueCache[issueCacheKey] ?? get().youtrackIssueCache[id]
    if (isFresh(cached)) {
      return cached.data
    }
    const inflight = inflightIssueRequests.get(issueCacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === youtrackMutationGeneration
    ) {
      return inflight.promise
    }
    let entry: InflightYouTrackReadRequest<YouTrackIssue | null>
    const requestMutationGeneration = youtrackMutationGeneration
    const promise = youtrackGetIssue(scope.settings, id, instanceId)
      .then((issue) => {
        if (
          inflightIssueRequests.get(issueCacheKey) === entry &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            youtrackIssueCache: evictStaleEntries({
              ...s.youtrackIssueCache,
              [issueCacheKey]: { data: issue, fetchedAt: Date.now() }
            })
          }))
        }
        return issue
      })
      .catch((error) => {
        console.warn('[youtrack] fetchYouTrackIssue failed:', error)
        if (
          isIntegrationCredentialDecryptionError(error) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          if (!shouldRefreshStatusAfterRead(instanceId, get().youtrackStatus)) {
            void get().checkYouTrackConnection()
          }
        } else if (
          looksLikeAuthError(error) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set({ youtrackStatus: { connected: false, viewer: null } })
        }
        return null
      })
      .finally(() => {
        if (inflightIssueRequests.get(issueCacheKey) === entry) {
          inflightIssueRequests.delete(issueCacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(instanceId, get().youtrackStatus) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkYouTrackConnection()
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    inflightIssueRequests.set(issueCacheKey, entry)
    return promise
  },

  searchYouTrackIssues: async (query, limit = 30, options) => {
    const scope = getYouTrackReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const instanceId = getSelectedInstanceId(get().youtrackStatus)
    const cacheKey = scopedYouTrackCacheKey(scope, `${instanceId ?? 'default'}::${query}::${limit}`)
    const cached = get().youtrackSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightSearchRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === youtrackMutationGeneration
    ) {
      return inflight.promise
    }
    let entry: InflightYouTrackReadRequest<YouTrackIssue[]>
    const requestMutationGeneration = youtrackMutationGeneration
    const promise = youtrackSearchIssues(scope.settings, query, limit, instanceId)
      .then((issues) => {
        if (
          inflightSearchRequests.get(cacheKey) === entry &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            youtrackSearchCache: evictStaleEntries({
              ...s.youtrackSearchCache,
              [cacheKey]: { data: issues, fetchedAt: Date.now() }
            })
          }))
        }
        return issues
      })
      .catch((error) => {
        console.warn('[youtrack] searchYouTrackIssues failed:', error)
        if (
          isIntegrationCredentialDecryptionError(error) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          if (!shouldRefreshStatusAfterRead(instanceId, get().youtrackStatus)) {
            void get().checkYouTrackConnection()
          }
        } else if (
          looksLikeAuthError(error) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set({ youtrackStatus: { connected: false, viewer: null } })
        }
        // Credential/auth failures are surfaced through connection state, so
        // they keep the empty-list contract. Other failures (forbidden, bad
        // query, network, 5xx) reject so the Tasks panel can show a real
        // error instead of a misleading "No issues found".
        if (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) {
          return []
        }
        throw error
      })
      .finally(() => {
        if (inflightSearchRequests.get(cacheKey) === entry) {
          inflightSearchRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(instanceId, get().youtrackStatus) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkYouTrackConnection()
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    inflightSearchRequests.set(cacheKey, entry)
    return promise
  },

  listYouTrackIssues: async (filter = 'assigned', limit = 30, options) => {
    const scope = getYouTrackReadScope(get().settings, options?.sourceContext)
    const { contextKey } = scope
    const instanceId = getSelectedInstanceId(get().youtrackStatus)
    const cacheKey = scopedYouTrackCacheKey(
      scope,
      `${instanceId ?? 'default'}::list::${filter}::${limit}`
    )
    const cached = get().youtrackSearchCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data ?? []
    }
    const inflight = inflightListRequests.get(cacheKey)
    if (
      inflight &&
      inflight.contextKey === contextKey &&
      inflight.mutationGeneration === youtrackMutationGeneration
    ) {
      return inflight.promise
    }
    let entry: InflightYouTrackReadRequest<YouTrackIssue[]>
    const requestMutationGeneration = youtrackMutationGeneration
    const promise = youtrackListIssues(scope.settings, filter, limit, instanceId)
      .then((issues) => {
        if (
          inflightListRequests.get(cacheKey) === entry &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set((s) => ({
            youtrackSearchCache: evictStaleEntries({
              ...s.youtrackSearchCache,
              [cacheKey]: { data: issues, fetchedAt: Date.now() }
            })
          }))
        }
        return issues
      })
      .catch((error) => {
        console.warn('[youtrack] listYouTrackIssues failed:', error)
        if (
          isIntegrationCredentialDecryptionError(error) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          if (!shouldRefreshStatusAfterRead(instanceId, get().youtrackStatus)) {
            void get().checkYouTrackConnection()
          }
        } else if (
          looksLikeAuthError(error) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          set({ youtrackStatus: { connected: false, viewer: null } })
        }
        // Credential/auth failures are surfaced through connection state, so
        // they keep the empty-list contract. Other failures (forbidden, bad
        // query, network, 5xx) reject so the Tasks panel can show a real
        // error instead of a misleading "No issues found".
        if (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) {
          return []
        }
        throw error
      })
      .finally(() => {
        if (inflightListRequests.get(cacheKey) === entry) {
          inflightListRequests.delete(cacheKey)
        }
        if (
          shouldRefreshStatusAfterRead(instanceId, get().youtrackStatus) &&
          canWriteYouTrackReadResult(
            contextKey,
            requestMutationGeneration,
            get().settings,
            scope.explicitSource
          )
        ) {
          void get().checkYouTrackConnection()
        }
      })
    entry = { promise, contextKey, mutationGeneration: requestMutationGeneration }
    inflightListRequests.set(cacheKey, entry)
    return promise
  },

  patchYouTrackIssue: (issueId, patch, options) => {
    const sourceScope =
      options?.sourceContext?.provider === 'youtrack'
        ? getTaskSourceCacheScope(options.sourceContext)
        : null
    const canPatchCacheKey = (key: string): boolean =>
      sourceScope === null || key.startsWith(`${sourceScope}::`)
    set((s) => {
      let changed = false
      const nextIssueCache = { ...s.youtrackIssueCache }
      for (const [key, entry] of Object.entries(nextIssueCache)) {
        if (!canPatchCacheKey(key) || entry?.data?.idReadable !== issueId) {
          continue
        }
        nextIssueCache[key] = { ...entry, data: { ...entry.data, ...patch }, fetchedAt: 0 }
        changed = true
      }
      const nextSearchCache = { ...s.youtrackSearchCache }
      for (const key of Object.keys(nextSearchCache)) {
        const entry = nextSearchCache[key]
        if (!canPatchCacheKey(key) || !entry?.data) {
          continue
        }
        const index = entry.data.findIndex((issue) => issue.idReadable === issueId)
        if (index === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        updatedItems[index] = { ...updatedItems[index], ...patch }
        nextSearchCache[key] = { ...entry, data: updatedItems }
        changed = true
      }
      return changed
        ? { youtrackIssueCache: nextIssueCache, youtrackSearchCache: nextSearchCache }
        : {}
    })
  }
})
