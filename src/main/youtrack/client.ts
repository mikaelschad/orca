/* eslint-disable max-lines -- Why: YouTrack credential storage and authenticated
request plumbing share one boundary so encrypted token lifecycle and
multi-instance selection cannot drift between task operations. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net, safeStorage, session } from 'electron'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { withSpan } from '../observability/tracer'
import type {
  YouTrackConnectArgs,
  YouTrackConnectionStatus,
  YouTrackInstance,
  YouTrackInstanceSelection,
  YouTrackViewer
} from '../../shared/types'

const YOUTRACK_API_USER_AGENT = 'Orca'

const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

export function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running += 1
      resolve()
    })
  )
}

export function release(): void {
  running -= 1
  const next = queue.shift()
  if (next) {
    next()
  }
}

type YouTrackInstanceFile = {
  version: 1
  activeInstanceId: string | null
  selectedInstanceId: YouTrackInstanceSelection | null
  instances: YouTrackInstance[]
}

export type YouTrackClientForInstance = {
  instance: YouTrackInstance
  authorization: string
}

export class YouTrackApiError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

let cachedInstanceFile: YouTrackInstanceFile | null = null
let instanceFileLoaded = false
const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per instance so getStatus can explain
// failing reads without re-touching the keychain on every status poll.
const credentialErrors = new Map<string, string>()

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getInstanceFilePath(): string {
  return join(getOrcaDir(), 'youtrack-instances.json')
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'youtrack-tokens')
}

function getTokenPath(instanceId: string): string {
  return join(getTokenDir(), `${Buffer.from(instanceId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureTokenDir(): void {
  const dir = getTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptyInstanceFile(): YouTrackInstanceFile {
  return {
    version: 1,
    activeInstanceId: null,
    selectedInstanceId: null,
    instances: []
  }
}

function hasStoredToken(instanceId: string): boolean {
  return cachedTokens.has(instanceId) || credentialFileHasContent(getTokenPath(instanceId))
}

function normalizeInstance(input: unknown): YouTrackInstance | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.baseUrl !== 'string' ||
    typeof record.displayName !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    baseUrl: record.baseUrl,
    displayName: record.displayName
  }
}

function readInstanceFileFromDisk(): YouTrackInstanceFile {
  const path = getInstanceFilePath()
  if (!existsSync(path)) {
    return emptyInstanceFile()
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    ) as Partial<YouTrackInstanceFile>
    const instances = Array.isArray(parsed.instances)
      ? parsed.instances
          .map((instance) => normalizeInstance(instance))
          .filter((instance): instance is YouTrackInstance => instance !== null)
          .filter((instance) => hasStoredToken(instance.id))
      : []
    const activeInstanceId =
      typeof parsed.activeInstanceId === 'string' &&
      instances.some((instance) => instance.id === parsed.activeInstanceId)
        ? parsed.activeInstanceId
        : (instances[0]?.id ?? null)
    const selectedInstanceId =
      parsed.selectedInstanceId === 'all' ||
      (typeof parsed.selectedInstanceId === 'string' &&
        instances.some((instance) => instance.id === parsed.selectedInstanceId))
        ? parsed.selectedInstanceId
        : activeInstanceId
    return { version: 1, activeInstanceId, selectedInstanceId, instances }
  } catch {
    return emptyInstanceFile()
  }
}

function getInstanceFile(): YouTrackInstanceFile {
  if (!instanceFileLoaded || !cachedInstanceFile) {
    cachedInstanceFile = readInstanceFileFromDisk()
    instanceFileLoaded = true
  }
  return cachedInstanceFile
}

function writeInstanceFile(file: YouTrackInstanceFile): void {
  ensureOrcaDir()
  const instances = file.instances.filter((instance) => hasStoredToken(instance.id))
  const activeInstanceId =
    file.activeInstanceId && instances.some((instance) => instance.id === file.activeInstanceId)
      ? file.activeInstanceId
      : (instances[0]?.id ?? null)
  const selectedInstanceId =
    file.selectedInstanceId === 'all'
      ? 'all'
      : file.selectedInstanceId &&
          instances.some((instance) => instance.id === file.selectedInstanceId)
        ? file.selectedInstanceId
        : activeInstanceId

  cachedInstanceFile = {
    version: 1,
    activeInstanceId,
    selectedInstanceId,
    instances
  }
  instanceFileLoaded = true
  writeFileSync(getInstanceFilePath(), JSON.stringify(cachedInstanceFile, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

function writeEncryptedToken(path: string, token: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 })
    return
  }
  console.warn('[youtrack] safeStorage encryption unavailable — storing token in plaintext')
  writeFileSync(path, token, { encoding: 'utf-8', mode: 0o600 })
}

function readToken(instanceId: string): string | null {
  const cached = cachedTokens.get(instanceId)
  if (cached !== undefined) {
    return cached
  }
  const path = getTokenPath(instanceId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path)
    const token = readStoredCredentialToken('YouTrack', raw)
    if (token) {
      cachedTokens.set(instanceId, token)
    }
    credentialErrors.delete(instanceId)
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(instanceId, error.message)
      throw error
    }
    return null
  }
}

function saveToken(instanceId: string, token: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  writeEncryptedToken(getTokenPath(instanceId), token)
  cachedTokens.set(instanceId, token)
  credentialErrors.delete(instanceId)
}

function deleteToken(instanceId: string): void {
  cachedTokens.delete(instanceId)
  credentialErrors.delete(instanceId)
  try {
    unlinkSync(getTokenPath(instanceId))
  } catch {
    // Token may not exist — safe to ignore.
  }
}

export function normalizeYouTrackBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function getInstanceId(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('base64url').slice(0, 24)
}

function toViewer(data: Record<string, unknown>): YouTrackViewer {
  return {
    id: typeof data.id === 'string' ? data.id : '',
    displayName:
      typeof data.fullName === 'string'
        ? data.fullName
        : typeof data.login === 'string'
          ? data.login
          : 'Unknown',
    email: typeof data.email === 'string' ? data.email : null,
    avatarUrl:
      data.avatarUrl && typeof data.avatarUrl === 'object'
        ? ((data.avatarUrl as Record<string, unknown>).url as string | undefined)
        : undefined
  }
}

function instanceToViewer(instance: YouTrackInstance | null): YouTrackViewer | null {
  if (!instance) {
    return null
  }
  return {
    id: instance.id,
    displayName: instance.displayName,
    email: null
  }
}

function authHeader(token: string): string {
  return `Bearer ${token}`
}

function describeErrorCause(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return cause === undefined ? undefined : String(cause)
}

async function youtrackFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'youtrack.request',
    async (span) => {
      span.setAttribute('youtrack.baseUrl', new URL(url).origin)
      await ensureElectronProxyFromEnvironment({
        proxySession: session.defaultSession,
        probeUrl: url
      }).catch((error) => {
        span.addEvent('youtrack.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        // Why: Electron's network stack follows Chromium proxy/session state,
        // avoiding undici's stale keep-alive sockets after VPN path changes.
        return await net.fetch(url, init)
      } catch (error) {
        span.setAttribute(
          'youtrack.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute(
          'youtrack.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('youtrack.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

async function requestWithToken(
  baseUrl: string,
  token: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', YOUTRACK_API_USER_AGENT)
  headers.set('Authorization', authHeader(token))
  const response = await youtrackFetch(`${baseUrl}/api${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new YouTrackApiError(await readYouTrackError(response), response.status)
  }
  if (response.status === 204) {
    return null
  }
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

async function readYouTrackError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error_description?: string; error?: string }
    if (data.error_description) {
      return data.error_description
    }
    if (data.error) {
      return data.error
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `YouTrack request failed (${response.status})`
}

export async function youtrackRequest<T>(
  client: YouTrackClientForInstance,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', YOUTRACK_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const response = await youtrackFetch(`${client.instance.baseUrl}/api${path}`, {
    ...init,
    headers
  })
  if (!response.ok) {
    throw new YouTrackApiError(await readYouTrackError(response), response.status)
  }
  if (response.status === 204) {
    return null as T
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

export function getClients(
  selection?: YouTrackInstanceSelection | null
): YouTrackClientForInstance[] {
  const file = getInstanceFile()
  const selected = selection ?? file.selectedInstanceId ?? file.activeInstanceId
  const isAllSelection = selected === 'all'
  const instances = isAllSelection
    ? file.instances
    : file.instances.filter((instance) => instance.id === (selected ?? file.activeInstanceId))

  return instances.flatMap((instance) => {
    let token: string | null
    try {
      token = readToken(instance.id)
    } catch (error) {
      // Why: under an 'all' selection one un-decryptable instance must not
      // collapse reads for the healthy ones. readToken already recorded the
      // per-instance credentialError for getStatus to surface, so skip this
      // instance like a missing token. A specific-instance selection still
      // rethrows so the renderer can surface the decrypt banner promptly.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ instance, authorization: authHeader(token) }] : []
  })
}

export function getStatus(): YouTrackConnectionStatus {
  const file = getInstanceFile()
  const instances = file.instances.filter((instance) => hasStoredToken(instance.id))
  const activeInstance =
    instances.find((instance) => instance.id === file.activeInstanceId) ?? instances[0] ?? null
  const credentialError = instances
    .map((instance) => credentialErrors.get(instance.id))
    .find((message) => message !== undefined)
  return {
    connected: instances.length > 0,
    viewer: instanceToViewer(activeInstance),
    instances,
    activeInstanceId: activeInstance?.id ?? null,
    selectedInstanceId: file.selectedInstanceId ?? activeInstance?.id ?? null,
    ...(credentialError ? { credentialError } : {})
  }
}

export async function connect(
  args: YouTrackConnectArgs
): Promise<{ ok: true; viewer: YouTrackViewer } | { ok: false; error: string }> {
  let baseUrl: string
  try {
    baseUrl = normalizeYouTrackBaseUrl(args.baseUrl)
  } catch {
    return { ok: false, error: 'Enter a valid YouTrack URL.' }
  }

  const token = args.token.trim()
  if (!token) {
    return { ok: false, error: 'A permanent token is required.' }
  }

  await acquire()
  try {
    const viewer = toViewer(
      (await requestWithToken(
        baseUrl,
        token,
        '/users/me?fields=id,login,fullName,email,avatarUrl(url)'
      )) as Record<string, unknown>
    )
    const id = getInstanceId(baseUrl)
    const instance: YouTrackInstance = {
      id,
      baseUrl,
      displayName: new URL(baseUrl).hostname
    }
    saveToken(id, token)
    const file = getInstanceFile()
    writeInstanceFile({
      version: 1,
      activeInstanceId: id,
      selectedInstanceId: id,
      instances: [instance, ...file.instances.filter((entry) => entry.id !== id)]
    })
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function disconnect(instanceId?: string): void {
  const file = getInstanceFile()
  const ids = instanceId ? [instanceId] : file.instances.map((instance) => instance.id)
  for (const id of ids) {
    deleteToken(id)
  }
  writeInstanceFile({
    version: 1,
    activeInstanceId: file.activeInstanceId,
    selectedInstanceId: file.selectedInstanceId,
    instances: file.instances.filter((instance) => !ids.includes(instance.id))
  })
}

export function selectInstance(instanceId: YouTrackInstanceSelection): YouTrackConnectionStatus {
  const file = getInstanceFile()
  if (instanceId !== 'all' && !file.instances.some((instance) => instance.id === instanceId)) {
    return getStatus()
  }
  writeInstanceFile({
    ...file,
    activeInstanceId: instanceId === 'all' ? file.activeInstanceId : instanceId,
    selectedInstanceId: instanceId
  })
  return getStatus()
}

export async function testConnection(
  instanceId?: string
): Promise<{ ok: true; viewer: YouTrackViewer } | { ok: false; error: string }> {
  let client: YouTrackClientForInstance | undefined
  try {
    client = getClients(instanceId)[0]
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!client) {
    return { ok: false, error: 'Not connected to YouTrack.' }
  }
  await acquire()
  try {
    const viewer = toViewer(
      (await youtrackRequest(
        client,
        '/users/me?fields=id,login,fullName,email,avatarUrl(url)'
      )) as Record<string, unknown>
    )
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearToken(instanceId: string): void {
  deleteToken(instanceId)
  const file = getInstanceFile()
  writeInstanceFile({
    ...file,
    instances: file.instances.filter((instance) => instance.id !== instanceId)
  })
}

export function isAuthError(error: unknown): boolean {
  // Why: YouTrack returns 403 for project/permission gaps even when
  // /users/me succeeds, so only 401 means the saved token itself is invalid.
  return error instanceof YouTrackApiError && error.status === 401
}
