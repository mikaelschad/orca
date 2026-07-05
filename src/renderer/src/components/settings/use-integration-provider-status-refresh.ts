import { useEffect } from 'react'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'

export function useIntegrationProviderStatusRefresh(): void {
  const settings = useAppStore((s) => s.settings)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const youtrackStatusChecked = useAppStore((s) => s.youtrackStatusChecked)
  const youtrackStatusContextKey = useAppStore((s) => s.youtrackStatusContextKey)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const checkYouTrackConnection = useAppStore((s) => s.checkYouTrackConnection)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const linearStatusCurrent = linearStatusContextKey === providerRuntimeContextKey
  const jiraStatusCurrent = jiraStatusContextKey === providerRuntimeContextKey
  const youtrackStatusCurrent = youtrackStatusContextKey === providerRuntimeContextKey

  useEffect(() => {
    if (!linearStatusCurrent || !linearStatusChecked) {
      void checkLinearConnection()
    }
    if (!jiraStatusCurrent || !jiraStatusChecked) {
      void checkJiraConnection()
    }
    if (!youtrackStatusCurrent || !youtrackStatusChecked) {
      void checkYouTrackConnection()
    }
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
  }, [
    checkJiraConnection,
    checkYouTrackConnection,
    checkLinearConnection,
    jiraStatusChecked,
    jiraStatusCurrent,
    jiraStatusContextKey,
    youtrackStatusChecked,
    youtrackStatusCurrent,
    youtrackStatusContextKey,
    linearStatusChecked,
    linearStatusCurrent,
    linearStatusContextKey,
    expectedPreflightContextKey,
    preflightStatusChecked,
    preflightStatusContextKey,
    preflightStatusCurrent,
    providerRuntimeContextKey,
    refreshPreflightStatus
  ])
}
