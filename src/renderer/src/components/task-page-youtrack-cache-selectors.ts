import type { CacheEntry } from '@/store/slices/github'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { YouTrackIssue } from '../../../shared/types'

type YouTrackIssueCache = Record<string, CacheEntry<YouTrackIssue>>
type YouTrackSearchCache = Record<string, CacheEntry<YouTrackIssue[]>>

export type TaskPageYouTrackIssueLookupOptions = {
  sourceContext?: TaskSourceContext | null
  instanceId?: string | null
}

export function findTaskPageYouTrackIssue(
  youtrackIssueCache: YouTrackIssueCache,
  youtrackSearchCache: YouTrackSearchCache,
  youtrackIssueId: string | null,
  options: TaskPageYouTrackIssueLookupOptions = {}
): YouTrackIssue | null {
  if (!youtrackIssueId) {
    return null
  }
  const sourceScope =
    options.sourceContext?.provider === 'youtrack'
      ? getTaskSourceCacheScope(options.sourceContext)
      : null
  const matchesLookup = (cacheKey: string, issue: YouTrackIssue | null | undefined): boolean => {
    if (!issue || issue.idReadable !== youtrackIssueId) {
      return false
    }
    if (options.instanceId && issue.instanceId !== options.instanceId) {
      return false
    }
    // Why: YouTrack issue ids are only unique within an instance, so drawer
    // lookup must not borrow a same-id issue cached for another host/account.
    return sourceScope === null || cacheKey.startsWith(`${sourceScope}::`)
  }

  for (const [cacheKey, entry] of Object.entries(youtrackIssueCache)) {
    if (matchesLookup(cacheKey, entry?.data)) {
      return entry.data
    }
  }

  for (const [cacheKey, entry] of Object.entries(youtrackSearchCache)) {
    const found = entry?.data?.find((issue) => matchesLookup(cacheKey, issue))
    if (found) {
      return found
    }
  }

  return null
}
