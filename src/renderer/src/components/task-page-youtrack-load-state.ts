import type { YouTrackIssue } from '../../../shared/types'

export type TaskPageYouTrackLoadError = {
  title: string
  details: string | null
}

export type TaskPageYouTrackLoadFailureState = {
  issues: YouTrackIssue[]
  error: TaskPageYouTrackLoadError
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load YouTrack issues.'
}

function getErrorCode(message: string): number | null {
  const explicit = /^Error\s+(\d{3})\b/i.exec(message)?.[1]
  if (explicit) {
    return Number(explicit)
  }
  if (/\bforbidden\b/i.test(message)) {
    return 403
  }
  if (/\bunauthorized\b|\bunauthenticated\b/i.test(message)) {
    return 401
  }
  if (/\btoo many requests\b|\brate limit\b/i.test(message)) {
    return 429
  }
  if (/\bservice unavailable\b/i.test(message)) {
    return 503
  }
  return null
}

function getErrorDetails(message: string, code: number | null): string | null {
  const normalized =
    code === null ? message : message.replace(new RegExp(`^Error\\s+${code}:\\s*`, 'i'), '')
  return normalized.trim() || null
}

function getIssueSearchErrorSummary(message: string, code: number | null): string {
  if (code === 401) {
    return 'YouTrack authentication failed. Reconnect YouTrack in Settings, then try again.'
  }
  if (code === 403) {
    return 'YouTrack denied access to this issue search. Check project permissions or try a different query.'
  }
  if (code === 429) {
    return 'YouTrack rate-limited this issue search. Try again in a moment.'
  }
  if (code !== null && code >= 500) {
    return 'YouTrack had a server error while loading issues. Try again in a moment.'
  }
  if (/\bquery\b|\bsyntax\b/i.test(message)) {
    return "YouTrack couldn't run this search query. Check the syntax and try again."
  }
  if (/\bnetwork\b|\bfetch failed\b|\btimed? ?out\b|\beconn/i.test(message)) {
    return "Couldn't reach YouTrack. Check your connection and try again."
  }
  return "Couldn't load YouTrack issues. Try again in a moment."
}

export function createTaskPageYouTrackLoadFailureState(
  error: unknown
): TaskPageYouTrackLoadFailureState {
  const message = getErrorMessage(error)
  const code = getErrorCode(message)
  const summary = getIssueSearchErrorSummary(message, code)
  return {
    issues: [],
    error: {
      title: code === null ? summary : `Error ${code}: ${summary}`,
      details: getErrorDetails(message, code)
    }
  }
}
