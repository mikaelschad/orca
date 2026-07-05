import { useId, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'

type YouTrackConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'

// Why: mirrors the inline Jira connect dialog in TaskPage so the onboarding
// "Connect integrations" step can reuse the same base URL + permanent token
// flow without depending on TaskPage's local state.
export function YouTrackConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: YouTrackConnectDialogProps): React.JSX.Element {
  const connectYouTrack = useAppStore((s) => s.connectYouTrack)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const baseUrlId = useId()
  const tokenId = useId()
  const errorId = useId()

  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  const canSubmit =
    Boolean(baseUrl.trim()) && Boolean(token.trim()) && connectState !== 'connecting'
  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? 'Your token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
    : 'Your token is stored locally and encrypted when local runtime storage supports it.'

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }

  const handleConnect = async (): Promise<void> => {
    const trimmedBaseUrl = baseUrl.trim()
    const trimmedToken = token.trim()
    if (!trimmedBaseUrl || !trimmedToken || connectState === 'connecting') {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectYouTrack({ baseUrl: trimmedBaseUrl, token: trimmedToken })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setBaseUrl('')
        setToken('')
        setConnectState('idle')
        onOpenChange(false)
        onConnected?.()
        return
      }
      setConnectState('error')
      setConnectError(result.error)
    } catch (error) {
      if (mountedRef.current) {
        setConnectState('error')
        setConnectError(error instanceof Error ? error.message : 'Connection failed')
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={overlayClassName}
        className={cn('sm:max-w-md', contentClassName)}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {translate(
              'auto.components.youtrack.connect.dialog.298b4b57a7',
              'Connect YouTrack instance'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.youtrack.connect.dialog.b125541728',
              'Use your YouTrack URL and a permanent token to browse issues.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleConnect()
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="space-y-2">
              <Label htmlFor={baseUrlId} className="text-xs">
                {translate('auto.components.youtrack.connect.dialog.b2bcb01a8d', 'YouTrack URL')}
              </Label>
              <Input
                id={baseUrlId}
                autoFocus
                placeholder={translate(
                  'auto.components.youtrack.connect.dialog.9e7ff67d23',
                  'https://youtrack.example.com'
                )}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={tokenId} className="text-xs">
                {translate('auto.components.youtrack.connect.dialog.ea2d419867', 'Permanent token')}
              </Label>
              <Input
                id={tokenId}
                type="password"
                placeholder={translate(
                  'auto.components.youtrack.connect.dialog.74fe9d55b1',
                  'perm:...'
                )}
                value={token}
                onChange={(event) => {
                  setToken(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
                aria-invalid={connectState === 'error'}
                aria-describedby={connectState === 'error' ? errorId : undefined}
              />
            </div>
            {connectState === 'error' && connectError ? (
              <p id={errorId} className="text-xs text-destructive">
                {connectError}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.youtrack.connect.dialog.2af68aabd7',
                'Create a permanent token in your YouTrack profile under Account Security → Tokens.'
              )}
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {credentialStorageCopy}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={connectState === 'connecting'}
            >
              {translate('auto.components.youtrack.connect.dialog.a0c6f661e3', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.youtrack.connect.dialog.6df80085c7', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.youtrack.connect.dialog.9854731a42', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
