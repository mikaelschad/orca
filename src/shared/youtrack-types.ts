export type YouTrackInstance = {
  id: string
  baseUrl: string
  displayName: string
}

export type YouTrackViewer = {
  id: string
  displayName: string
  email: string | null
  avatarUrl?: string
}

export type YouTrackInstanceSelection = string | 'all'

export type YouTrackConnectionStatus = {
  connected: boolean
  viewer: YouTrackViewer | null
  instances?: YouTrackInstance[]
  activeInstanceId?: string | null
  selectedInstanceId?: YouTrackInstanceSelection | null
  // Set when a stored token file exists but could not be decrypted, so the
  // UI can explain reads failing while the connection still looks saved.
  credentialError?: string
}

export type YouTrackProject = {
  id: string
  shortName: string
  name: string
  instanceId?: string
  instanceName?: string
}

export type YouTrackUser = {
  id: string
  displayName: string
  email?: string | null
  avatarUrl?: string
}

export type YouTrackStatus = {
  name: string
  resolved: boolean
}

export type YouTrackPriority = {
  name: string
}

export type YouTrackIssue = {
  id: string
  idReadable: string
  instanceId?: string
  instanceName?: string
  title: string
  description?: string
  url: string
  project: YouTrackProject
  status?: YouTrackStatus
  labels: string[]
  assignee?: YouTrackUser
  reporter?: YouTrackUser
  priority?: YouTrackPriority
  updatedAt: string
  createdAt: string
}

export type YouTrackComment = {
  id: string
  body: string
  createdAt: string
  updatedAt?: string
  user?: YouTrackUser
}

export type YouTrackIssueUpdate = {
  title?: string
  description?: string
  assigneeId?: string | null
  stateName?: string
  priorityName?: string
}

export type YouTrackIssueFilter = 'assigned' | 'reported' | 'all' | 'unresolved'

export type YouTrackConnectArgs = {
  baseUrl: string
  token: string
}

export type YouTrackCreateIssueArgs = {
  instanceId?: string
  projectId: string
  title: string
  description?: string
}

export type YouTrackCreateIssueResult =
  | { ok: true; id: string; idReadable: string; url: string }
  | { ok: false; error: string }

export type YouTrackMutationResult = { ok: true } | { ok: false; error: string }
