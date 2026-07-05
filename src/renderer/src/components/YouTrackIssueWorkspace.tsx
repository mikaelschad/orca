/* eslint-disable max-lines -- Why: the YouTrack drawer co-locates preview,
   metadata edits, and comments so the task page has one full issue surface. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: YouTrack issue hydration and comments are loaded from provider IPC for the selected issue. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Clipboard,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Save,
  Send,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  youtrackAddIssueComment,
  youtrackGetIssue,
  youtrackIssueComments,
  youtrackUpdateIssue
} from '@/runtime/runtime-youtrack-client'
import type { YouTrackComment, YouTrackIssue } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

type YouTrackIssueWorkspaceProps = {
  issue: YouTrackIssue | null
  onUse: (issue: YouTrackIssue) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeFormatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeFormatter.format(diffHours, 'hour')
  }
  return relativeFormatter.format(Math.round(diffHours / 24), 'day')
}

function buildYouTrackBranchName(issue: YouTrackIssue): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  return `${issue.idReadable.toLowerCase()}${slug ? `-${slug}` : ''}`
}

function buildYouTrackPrompt(issue: YouTrackIssue): string {
  return `Complete YouTrack issue ${issue.idReadable}: ${issue.title}\n\n${issue.url}`
}

function youtrackStatusClass(resolved: boolean): string {
  return resolved
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.YouTrackIssueWorkspace.c432b957b7', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.YouTrackIssueWorkspace.5a267e1d47', 'Failed to copy {{value0}}', {
        value0: label.toLowerCase()
      })
    )
  }
}

export default function YouTrackIssueWorkspace({
  issue,
  onUse,
  onClose,
  sourceContext
}: YouTrackIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const patchYouTrackIssue = useAppStore((s) => s.patchYouTrackIssue)
  const [fullIssue, setFullIssue] = useState<YouTrackIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [comments, setComments] = useState<YouTrackComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)
  const optimisticCommentsRef = useRef<YouTrackComment[]>([])

  const displayed = fullIssue ?? issue
  const instanceId = displayed?.instanceId ?? undefined

  const loadComments = useCallback(
    async (targetIssue: YouTrackIssue, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await youtrackIssueComments(
          providerSettings,
          targetIssue.idReadable,
          targetIssue.instanceId
        )
        if (requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.id))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
        }
        setComments(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [providerSettings]
  )

  useEffect(() => {
    if (!issue) {
      setFullIssue(null)
      setIssueLoading(false)
      setComments([])
      setCommentsError(null)
      setCommentDraft('')
      optimisticCommentsRef.current = []
      return
    }

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    optimisticCommentsRef.current = []
    setFullIssue(issue)
    setTitleDraft(issue.title)
    setComments([])
    setCommentsError(null)
    setIssueLoading(true)

    void youtrackGetIssue(providerSettings, issue.idReadable, issue.instanceId)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFullIssue(result)
          setTitleDraft(result.title)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIssueLoading(false)
        }
      })

    void loadComments(issue, requestId)
  }, [issue, loadComments, providerSettings])

  const refreshIssue = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    try {
      const latest = await youtrackGetIssue(providerSettings, displayed.idReadable, instanceId)
      if (latest) {
        setFullIssue(latest)
        patchYouTrackIssue(latest.idReadable, latest, { sourceContext })
      }
    } catch {
      // Keep the visible issue snapshot if refresh fails.
    }
  }, [displayed, instanceId, patchYouTrackIssue, providerSettings, sourceContext])

  const mutateIssue = useCallback(
    async (
      field: string,
      updates: Parameters<typeof youtrackUpdateIssue>[2],
      optimistic?: Partial<YouTrackIssue>
    ): Promise<void> => {
      if (!displayed || pendingField) {
        return
      }
      setPendingField(field)
      const previous = displayed
      try {
        if (optimistic) {
          setFullIssue({ ...displayed, ...optimistic })
          patchYouTrackIssue(displayed.idReadable, optimistic, { sourceContext })
        }
        const result = await youtrackUpdateIssue(
          providerSettings,
          displayed.idReadable,
          updates,
          instanceId
        )
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshIssue()
      } catch (error) {
        setFullIssue(previous)
        patchYouTrackIssue(previous.idReadable, previous, { sourceContext })
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.YouTrackIssueWorkspace.220c5f00b7',
                'Failed to update YouTrack issue.'
              )
        )
      } finally {
        setPendingField(null)
      }
    },
    [
      displayed,
      instanceId,
      patchYouTrackIssue,
      pendingField,
      refreshIssue,
      providerSettings,
      sourceContext
    ]
  )

  const handleSaveTitle = useCallback(() => {
    if (!displayed) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      setTitleDraft(displayed.title)
      return
    }
    void mutateIssue('title', { title }, { title })
  }, [displayed, mutateIssue, titleDraft])

  const handleSubmitComment = useCallback(async (): Promise<void> => {
    if (!displayed || commentSubmitting) {
      return
    }
    const bodyState = getCommentBodySubmitState(commentDraft)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.YouTrackIssueWorkspace.c4a28ce57d',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setCommentSubmitting(true)
    try {
      const result = await youtrackAddIssueComment(
        providerSettings,
        displayed.idReadable,
        bodyState.body,
        instanceId
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      const comment: YouTrackComment = {
        id: result.id || createBrowserUuid(),
        body: bodyState.body,
        createdAt: new Date().toISOString(),
        user: { id: 'local', displayName: 'You' }
      }
      optimisticCommentsRef.current.push(comment)
      setComments((prev) => [...prev, comment])
      setCommentDraft('')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.YouTrackIssueWorkspace.d2c46439cf', 'Failed to add comment.')
      )
    } finally {
      setCommentSubmitting(false)
    }
  }, [commentDraft, commentSubmitting, displayed, instanceId, providerSettings])
  const canSubmitComment = hasBoundedCommentBodyText(commentDraft)

  const actionItems = displayed
    ? [
        {
          label: translate('auto.components.YouTrackIssueWorkspace.704c9d5bb7', 'Open in YouTrack'),
          icon: ExternalLink,
          action: () => window.api.shell.openUrl(displayed.url)
        },
        {
          label: translate('auto.components.YouTrackIssueWorkspace.7ec70614a2', 'Copy URL'),
          icon: Clipboard,
          action: () => void copyTextToClipboard(displayed.url, 'URL')
        },
        {
          label: translate('auto.components.YouTrackIssueWorkspace.e4cc5f1e33', 'Copy ID'),
          icon: Clipboard,
          action: () => void copyTextToClipboard(displayed.idReadable, 'ID')
        },
        {
          label: translate(
            'auto.components.YouTrackIssueWorkspace.2b53725da1',
            'Copy suggested branch name'
          ),
          icon: GitBranch,
          action: () => void copyTextToClipboard(buildYouTrackBranchName(displayed), 'Branch name')
        },
        {
          label: translate('auto.components.YouTrackIssueWorkspace.080462ec6e', 'Copy prompt'),
          icon: Clipboard,
          action: () => void copyTextToClipboard(buildYouTrackPrompt(displayed), 'Prompt')
        }
      ]
    : []

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>{displayed?.title ?? 'YouTrack issue'}</SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.YouTrackIssueWorkspace.029fa1548e',
              'Preview, edit, and start work from the selected issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">{displayed.idReadable}</span>
                    {displayed.instanceName ? <span>{displayed.instanceName}</span> : null}
                    <span>{displayed.project.shortName}</span>
                    <span>{formatRelativeTime(displayed.updatedAt)}</span>
                    {issueLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  </div>
                  <h2 className="mt-1 text-[20px] font-semibold leading-tight text-foreground">
                    {displayed.title}
                  </h2>
                </div>
                <Button
                  onClick={() => onUse(displayed)}
                  className="hidden shrink-0 gap-2 sm:inline-flex"
                  size="sm"
                >
                  {translate(
                    'auto.components.YouTrackIssueWorkspace.6809673e1e',
                    'Start workspace'
                  )}
                  <ArrowRight className="size-4" />
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      onClick={onClose}
                      aria-label={translate(
                        'auto.components.YouTrackIssueWorkspace.0a78ac85f5',
                        'Close YouTrack issue preview'
                      )}
                    >
                      <X className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate('auto.components.YouTrackIssueWorkspace.a3257376a2', 'Close')}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
              {displayed.status ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                    youtrackStatusClass(displayed.status.resolved)
                  )}
                >
                  {displayed.status.name}
                </span>
              ) : null}
              <span className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {displayed.priority?.name ?? 'No priority'}
              </span>
              <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {displayed.assignee?.displayName ?? 'Unassigned'}
              </span>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_228px]">
              <div className="min-h-0 overflow-y-auto scrollbar-sleek">
                <section className="border-b border-border/40 px-4 py-4">
                  <div className="grid gap-2">
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {translate('auto.components.YouTrackIssueWorkspace.0dd9c68cd5', 'Title')}
                    </label>
                    <div className="flex gap-2">
                      <Input
                        value={titleDraft}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            handleSaveTitle()
                          }
                        }}
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSaveTitle}
                        disabled={pendingField === 'title'}
                      >
                        {pendingField === 'title' ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Save className="size-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </section>

                <section className="border-b border-border/40 px-4 py-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {displayed.project.shortName} ·{' '}
                      {displayed.assignee?.displayName ?? 'Unassigned'}
                    </span>
                  </div>
                  {displayed.description?.trim() ? (
                    <CommentMarkdown
                      content={displayed.description}
                      variant="document"
                      className="text-[14px] leading-relaxed"
                    />
                  ) : (
                    <p className="text-sm italic text-muted-foreground">
                      {translate(
                        'auto.components.YouTrackIssueWorkspace.a325f4ecf3',
                        'No description provided.'
                      )}
                    </p>
                  )}
                </section>

                <section className="px-4 py-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">
                        {translate('auto.components.YouTrackIssueWorkspace.65656f6549', 'Comments')}
                      </span>
                      {comments.length > 0 ? (
                        <span className="text-[12px] text-muted-foreground">{comments.length}</span>
                      ) : null}
                    </div>
                    {commentsError ? (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => void loadComments(displayed, requestIdRef.current)}
                        disabled={commentsLoading}
                        className="gap-1"
                      >
                        {commentsLoading ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        {translate('auto.components.YouTrackIssueWorkspace.974e15ef29', 'Retry')}
                      </Button>
                    ) : null}
                  </div>
                  {commentsError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {commentsError}
                    </div>
                  ) : commentsLoading && comments.length === 0 ? (
                    <div className="flex items-center justify-center py-8">
                      <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : comments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {translate(
                        'auto.components.YouTrackIssueWorkspace.5fc395c32a',
                        'No comments yet.'
                      )}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {comments.map((comment) => (
                        <div
                          key={comment.id}
                          className="rounded-md border border-border/50 bg-muted/20"
                        >
                          <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                            {comment.user?.avatarUrl ? (
                              <img
                                src={comment.user.avatarUrl}
                                alt=""
                                className="size-5 shrink-0 rounded-full"
                              />
                            ) : null}
                            <span className="truncate text-[13px] font-semibold text-foreground">
                              {comment.user?.displayName ?? 'Unknown'}
                            </span>
                            <span className="shrink-0 text-[12px] text-muted-foreground">
                              {formatRelativeTime(comment.createdAt)}
                            </span>
                          </div>
                          <div className="px-3 py-2">
                            <CommentMarkdown
                              content={comment.body}
                              className="text-[13px] leading-relaxed"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <aside className="border-t border-border/50 bg-muted/20 px-3 py-3 xl:border-l xl:border-t-0">
                <Button
                  onClick={() => onUse(displayed)}
                  className="mb-3 w-full justify-center gap-2 sm:hidden"
                >
                  {translate(
                    'auto.components.YouTrackIssueWorkspace.6809673e1e',
                    'Start workspace'
                  )}
                  <ArrowRight className="size-4" />
                </Button>
                <div className="grid gap-1">
                  {actionItems.map((item) => {
                    const Icon = item.icon
                    return (
                      <Tooltip key={item.label}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={item.action}
                            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
                          >
                            <Icon className="size-3.5 shrink-0" />
                            <span className="truncate">{item.label}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="left" sideOffset={6}>
                          {item.label}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              </aside>
            </div>

            <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
              <div className="flex gap-2">
                <textarea
                  value={commentDraft}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  placeholder={translate(
                    'auto.components.YouTrackIssueWorkspace.d1493d5625',
                    'Add a YouTrack comment...'
                  )}
                  rows={2}
                  disabled={commentSubmitting}
                  className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <Button
                  onClick={() => void handleSubmitComment()}
                  disabled={!canSubmitComment || commentSubmitting}
                  className="self-end gap-2"
                >
                  {commentSubmitting ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  {translate('auto.components.YouTrackIssueWorkspace.4ff0ec17e7', 'Comment')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
