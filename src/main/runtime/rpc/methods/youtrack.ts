import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from '../schemas'

const VALID_FILTERS = ['assigned', 'reported', 'all', 'unresolved'] as const

const InstanceSelection = z
  .object({
    instanceId: OptionalString
  })
  .optional()

const Connect = z.object({
  baseUrl: requiredString('URL is required'),
  token: requiredString('Permanent token is required')
})

const SelectInstance = z.object({
  instanceId: requiredString('Instance ID is required')
})

const SearchIssues = z.object({
  query: OptionalPlainString,
  limit: OptionalFiniteNumber,
  instanceId: OptionalString
})

const ListIssues = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    instanceId: OptionalString
  })
  .optional()

const IssueId = z.object({
  id: requiredString('Issue id is required'),
  instanceId: OptionalString
})

const CreateIssue = z.object({
  instanceId: OptionalString,
  projectId: requiredString('Project is required'),
  title: requiredString('Title is required'),
  description: OptionalPlainString
})

const IssueUpdate = z.object({
  id: requiredString('Issue id is required'),
  instanceId: OptionalString,
  updates: z.object({
    title: OptionalString,
    description: OptionalPlainString,
    assigneeId: z.union([z.string(), z.null()]).optional(),
    stateName: OptionalString,
    priorityName: OptionalString
  })
})

const IssueComment = z.object({
  id: requiredString('Issue id is required'),
  body: requiredString('Comment body is required'),
  instanceId: OptionalString
})

export const YOUTRACK_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'youtrack.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.youtrackConnect({
        baseUrl: params.baseUrl.trim(),
        token: params.token.trim()
      })
  }),
  defineMethod({
    name: 'youtrack.disconnect',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.youtrackDisconnect(params?.instanceId)
  }),
  defineMethod({
    name: 'youtrack.selectInstance',
    params: SelectInstance,
    handler: async (params, { runtime }) => runtime.youtrackSelectInstance(params.instanceId.trim())
  }),
  defineMethod({
    name: 'youtrack.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.youtrackStatus()
  }),
  defineMethod({
    name: 'youtrack.testConnection',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.youtrackTestConnection(params?.instanceId)
  }),
  defineMethod({
    name: 'youtrack.searchIssues',
    params: SearchIssues,
    handler: async (params, { runtime }) =>
      runtime.youtrackSearchIssues(params.query?.trim() ?? '', params.limit, params.instanceId)
  }),
  defineMethod({
    name: 'youtrack.listIssues',
    params: ListIssues,
    handler: async (params, { runtime }) =>
      runtime.youtrackListIssues(params?.filter, params?.limit, params?.instanceId)
  }),
  defineMethod({
    name: 'youtrack.getIssue',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.youtrackGetIssue(params.id.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'youtrack.createIssue',
    params: CreateIssue,
    handler: async (params, { runtime }) =>
      runtime.youtrackCreateIssue({
        instanceId: params.instanceId,
        projectId: params.projectId.trim(),
        title: params.title.trim(),
        description: params.description?.trim() || undefined
      })
  }),
  defineMethod({
    name: 'youtrack.updateIssue',
    params: IssueUpdate,
    handler: async (params, { runtime }) =>
      runtime.youtrackUpdateIssue(params.id.trim(), params.updates, params.instanceId)
  }),
  defineMethod({
    name: 'youtrack.addIssueComment',
    params: IssueComment,
    handler: async (params, { runtime }) =>
      runtime.youtrackAddIssueComment(params.id.trim(), params.body.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'youtrack.issueComments',
    params: IssueId,
    handler: async (params, { runtime }) =>
      runtime.youtrackIssueComments(params.id.trim(), params.instanceId)
  }),
  defineMethod({
    name: 'youtrack.listProjects',
    params: InstanceSelection,
    handler: async (params, { runtime }) => runtime.youtrackListProjects(params?.instanceId)
  })
]
