import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { YouTrackConnectDialog } from '@/components/youtrack-connect-dialog'
import { YouTrackIcon } from '@/components/icons/YouTrackIcon'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getProviderRuntimeContextKey,
  hasRemoteProviderRuntime
} from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { getProviderAccountScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { translate } from '@/i18n/i18n'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function YouTrackIntegrationCard(): React.JSX.Element {
  const youtrackStatus = useAppStore((s) => s.youtrackStatus)
  const youtrackStatusChecked = useAppStore((s) => s.youtrackStatusChecked)
  const youtrackStatusContextKey = useAppStore((s) => s.youtrackStatusContextKey)
  const checkYouTrackConnection = useAppStore((s) => s.checkYouTrackConnection)
  const disconnectYouTrack = useAppStore((s) => s.disconnectYouTrack)
  const testYouTrackConnection = useAppStore((s) => s.testYouTrackConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingInstanceId, setTestingInstanceId] = useState<string | null>(null)
  const [testResultByInstance, setTestResultByInstance] = useState<
    Record<string, VerificationResult>
  >({})

  const contextMatches = youtrackStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !youtrackStatusChecked
  const connected = contextMatches && youtrackStatus.connected
  const instances = youtrackStatus.instances ?? []
  const instanceCount = instances.length || (connected ? 1 : 0)
  const accountScope = getProviderAccountScope(settings)
  const credentialCopy = hasRemoteProviderRuntime(settings)
    ? 'Connect a YouTrack instance with its URL and a permanent token. Credentials are sent to the selected remote runtime and stored there with runtime-supported encryption.'
    : 'Connect a YouTrack instance with its URL and a permanent token. Credentials are stored locally and encrypted when local runtime storage supports it.'
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')

  const handleDisconnect = async (instanceId?: string): Promise<void> => {
    await disconnectYouTrack(instanceId)
    if (mountedRef.current) {
      setTestResultByInstance({})
    }
  }

  const handleTest = async (instanceId: string): Promise<void> => {
    setTestingInstanceId(instanceId)
    setTestResultByInstance((prev) => {
      const next = { ...prev }
      delete next[instanceId]
      return next
    })
    const result = await testYouTrackConnection(instanceId)
    if (!mountedRef.current) {
      return
    }
    setTestResultByInstance((prev) => ({
      ...prev,
      [instanceId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
    }))
    setTestingInstanceId(null)
  }

  return (
    <IntegrationCardShell
      icon={<YouTrackIcon className="size-5" />}
      name="YouTrack"
      description={
        connected
          ? translate(
              'auto.components.settings.youtrack.integration.card.fdbadc57a4',
              '{{value0}} instance{{value1}} connected',
              { value0: instanceCount, value1: instanceCount === 1 ? '' : 's' }
            )
          : checking
            ? translate(
                'auto.components.settings.youtrack.integration.card.3ff0fee7e7',
                'Checking YouTrack access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.youtrack.integration.card.3c9fe0f2ef',
                'Browse, create, and start work from YouTrack issues.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={connected ? 'Connected' : 'Not connected'}
      actions={
        !checking ? (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connected
              ? translate(
                  'auto.components.settings.youtrack.integration.card.8d9803037d',
                  'Add YouTrack instance'
                )
              : translate(
                  'auto.components.settings.youtrack.integration.card.bb42469593',
                  'Connect YouTrack'
                )}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <ProviderHostScopeControl
          labelPrefix="Account scope"
          scope={accountScope}
          className={accountScopeRowClass}
        />
        {connected && instances.length > 0 ? (
          <div className="space-y-2">
            {instances.map((instance) => {
              const testResult = testResultByInstance[instance.id]
              const testing = testingInstanceId === instance.id
              return (
                <div key={instance.id} className={subordinateRowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {instance.displayName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{instance.baseUrl}</p>
                  </div>
                  {testResult?.state === 'ok' ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                      <CheckCircle2 className="size-3.5" />
                      {translate(
                        'auto.components.settings.youtrack.integration.card.07c14512b3',
                        'Verified'
                      )}
                    </span>
                  ) : null}
                  {testResult?.state === 'error' ? (
                    <span className="flex min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-destructive">
                      <AlertCircle className="size-3.5 shrink-0" />
                      <span className="truncate">{testResult.error}</span>
                    </span>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleTest(instance.id)}
                    disabled={testing}
                  >
                    {testing ? (
                      <>
                        <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                        {translate(
                          'auto.components.settings.youtrack.integration.card.f9f81a10ff',
                          'Testing...'
                        )}
                      </>
                    ) : (
                      translate(
                        'auto.components.settings.youtrack.integration.card.10a63dff43',
                        'Test'
                      )
                    )}
                  </Button>
                  <button
                    onClick={() => void handleDisconnect(instance.id)}
                    aria-label={translate(
                      'auto.components.settings.youtrack.integration.card.73dc21abc7',
                      'Disconnect {{value0}}',
                      { value0: instance.displayName }
                    )}
                    className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                  >
                    <Unlink className="size-3.5" />
                  </button>
                </div>
              )
            })}
            <p className="text-[11px] text-muted-foreground/70">
              {translate(
                'auto.components.settings.youtrack.integration.card.42a879d06a',
                'Each connected YouTrack instance has one token stored by the active runtime.'
              )}
            </p>
          </div>
        ) : connected ? (
          <>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.youtrack.integration.card.111f13a625',
                'YouTrack is connected for this runtime. Re-check if the connected instance list looks stale.'
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void checkYouTrackConnection()}>
                {translate(
                  'auto.components.settings.youtrack.integration.card.85c5e8952b',
                  'Re-check'
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleDisconnect()}>
                {translate(
                  'auto.components.settings.youtrack.integration.card.disconnect_all',
                  'Disconnect'
                )}
              </Button>
            </div>
          </>
        ) : !checking ? (
          <>
            <p className="text-xs text-muted-foreground">{credentialCopy}</p>
            <Button variant="ghost" size="sm" onClick={() => void checkYouTrackConnection()}>
              {translate(
                'auto.components.settings.youtrack.integration.card.85c5e8952b',
                'Re-check'
              )}
            </Button>
          </>
        ) : null}
      </IntegrationCardDetails>

      <YouTrackConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => setTestResultByInstance({})}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}
