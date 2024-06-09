// noinspection ExceptionCaughtLocallyJS

import * as core from '@actions/core'
import { wait } from './wait'

import github from '@actions/github'
import { HttpClient } from '@actions/http-client'
import * as fs from 'fs'
import { parse } from 'yaml'
import { TypedResponse } from '@actions/http-client/lib/interfaces'

const _http = new HttpClient()
const token = core.getInput('auth-token', { required: true })

interface Manifest {
  project?: {
    parent?: string
  }
  applications: {
    [app: string]: ManifestApp
  }
}

interface ManifestApp {
  pool?: string
  php?: {
    version?: string
    ini?: {
      [key: string]: string | boolean
    }
  }
  databases?: {
    [key: string]: string
  }
  web: {
    [domainName: string]: ManifestAppWeb
  }
}

interface ManifestAppWeb {
  alias?: string[]
  root?: string
  redirect?: boolean
  previewDomain?: boolean
  locations: {
    [matchString: string]: {
      passthru?: string | boolean
      expires?: boolean
      allow?: boolean
    }
  }
}

interface ApiResponse {
  errors: object[]
  metadata: {
    clientTransactionId: string
    serverTransactionId: string
  }
  status: string
  warnings: string[]
}

interface ApiFindResponse<T> extends ApiResponse {
  response: {
    data: T[]
    limit: number
    page: number
    totalEntries: number
    totalPages: number
    type: string
  }
}

interface ApiActionResponse<T> extends ApiResponse {
  response: T
}

interface WebspaceAccess {
  addDate: string
  ftpAccess: boolean
  lastChangeDate: string
  sshAccess: boolean
  statsAccess: boolean
  userId: string
  userName: string
  webspaceId: string
}

interface WebspaceResult {
  id: string
  name: string
  comments: string
  webspaceName: string
  productCode: string
  hostName: string
  poolId: string
  cronJobs: object[]
  status: string
  accesses: WebspaceAccess[]
}

interface VhostResult {
  id: string
  domainName: string
  additionalDomainNames: string[]
  enableAlias: boolean
  redirectToPrimaryName: boolean
  enableSystemAlias: boolean
  systemAlias: string
  webRoot: string
  phpVersion: string
  serverType: string
  httpUsers: object[]
  locations: object[]
  sslSettings: object
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const appKey: string = core.getInput('app', { required: true })
    const webspaceUser: string = core.getInput('webspace-user', {
      required: true
    })
    const webspacePrefix: string = core.getInput('webspace-prefix', {
      required: true
    })
    const webspaceName: string =
      `${webspacePrefix}-${appKey}-${github.context.payload.ref}`.trim()
    const webRoot: string = webspaceName
      .toLowerCase()
      .replace(/[^a-z0-9-/]/, '')
    const manifest: Manifest = parse(
      fs.readFileSync('./.hosting/config.yaml', 'utf8')
    )
    const app = manifest.applications[appKey] ?? null
    if (null === app) {
      throw new Error(
        `Cannot find "applications.${appKey}" in the ".hosting/config.yaml" manifest.`
      )
    }
    let webspace: WebspaceResult
    let foundWebspace: WebspaceResult | null =
      await findOneWebspaceByName(webspaceName)
    if (null !== foundWebspace) {
      webspace = foundWebspace
      core.info(`Using webspace ${webspace.id}`)
    } else {
      core.info('Creating a new webspace…')
      webspace = await createWebspace(app, webspaceName, webspaceUser)

      do {
        await wait(2000)
        core.info(`Waiting for webspace ${webspace.id} to boot…`)
        foundWebspace = await findWebspaceById(webspaceUser)
        if (null === foundWebspace) {
          break
        }
        webspace = foundWebspace
      } while ('active' !== webspace.status)
    }

    const webspaceAccess: WebspaceAccess | null =
      webspace.accesses.find(a => a.userId === webspaceUser) ?? null
    const sshUser = webspaceAccess?.userName
    const sshHost = webspace.hostName
    const httpUser = webspace.webspaceName

    core.setOutput('ssh-user', sshUser)
    core.setOutput('ssh-host', sshHost)
    core.setOutput('ssh-port', 2244)
    core.setOutput('http-user', httpUser)

    const foundVhosts: VhostResult[] = await findVhostByWebspace(webspaceName)
    for (const [domainName, web] of Object.entries(app.web)) {
      const foundVhost =
        foundVhosts.find(v => v.domainName === domainName) ?? null
      let vhost: VhostResult
      if (null === foundVhost) {
        core.info(`Creating a vHost for ${domainName}`)
        vhost = await createVhost(webspace, web, app, domainName, webRoot)
      } else {
        vhost = foundVhost
        if (mustBeUpdated(vhost, app, web, webRoot)) {
          core.info(`Updating vHost for ${domainName}`)

          // todo
        }
      }

      core.setOutput('deploy-path', `/home/${httpUser}/html/${webRoot}`)
    }

    for (const relict of foundVhosts.filter(
      v => !Object.keys(app.web).includes(v.domainName)
    )) {
      await deleteVhostById(relict.id)
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

function mustBeUpdated(
  vhost: VhostResult,
  app: ManifestApp,
  web: ManifestAppWeb,
  webRoot: string
): boolean {
  if (app.php?.version && app.php.version !== vhost.phpVersion) {
    return true
  }

  // todo phpini

  if (
    web.alias?.length !== vhost.additionalDomainNames.length ||
    web.alias.every((v, i) => v !== vhost.additionalDomainNames[i])
  ) {
    return true
  }

  if (
    `${webRoot}/current/${web.root ?? ''}`.replace(/\/$/, '') !== vhost.webRoot
  ) {
    return true
  }

  if (vhost.redirectToPrimaryName !== web.redirect ?? true) {
    return true
  }

  if (vhost.enableSystemAlias !== web.previewDomain ?? false) {
    return true
  }

  // todo locations

  return false
}

async function findOneWebspaceByName(
  webspaceName: string
): Promise<WebspaceResult | null> {
  const response: TypedResponse<ApiFindResponse<WebspaceResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/webspacesFind',
      {
        authToken: token,
        limit: 1,
        filter: {
          field: 'webspaceName',
          value: webspaceName
        }
      }
    )
  if (response.result?.response?.totalEntries ?? 0 > 1) {
    throw new Error(
      `We found more than 1 webspace with name "${webspaceName}" and cannot know where to deploy to.`
    )
  }

  return response.result?.response?.data[0] ?? null
}

async function findWebspaceById(
  webspaceId: string
): Promise<WebspaceResult | null> {
  const response: TypedResponse<ApiFindResponse<WebspaceResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/webspacesFind',
      {
        authToken: token,
        limit: 1,
        filter: {
          field: 'webspaceId',
          value: webspaceId
        }
      }
    )

  return response.result?.response?.data[0] ?? null
}

async function deleteVhostById(vhostId: string): Promise<void> {
  await _http.postJson(
    'https://secure.hosting.de/api/webhosting/v1/json/vhostDelete',
    {
      authToken: token,
      vhostId
    }
  )
}

async function findVhostByWebspace(webspaceId: string): Promise<VhostResult[]> {
  const response: TypedResponse<ApiFindResponse<VhostResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/vhostsFind',
      {
        authToken: token,
        limit: 1,
        filter: {
          field: 'webspaceId',
          value: webspaceId
        }
      }
    )

  return response.result?.response?.data ?? []
}

async function createWebspace(
  manifest: ManifestApp,
  name: string,
  user: string
): Promise<WebspaceResult> {
  const response: TypedResponse<ApiActionResponse<WebspaceResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/webspaceCreate',
      {
        authToken: token,
        webspace: {
          name,
          comments:
            'Created by setup-hostingde github action. Please do not change name.',
          productCode: 'webhosting-webspace-v1-1m',
          cronJobs: []
        },
        accesses: [
          {
            userId: user,
            sshAccess: true
          }
        ],
        poolId: manifest.pool ?? null
      }
    )

  if (null === response.result) {
    throw new Error('Unexpected error')
  }

  return response.result.response
}

function transformPhpIni(ini: object): object {
  return Object.entries(ini).map(([k, v]) => ({ key: k, value: v }))
}

async function createVhost(
  webspace: WebspaceResult,
  web: ManifestAppWeb,
  app: ManifestApp,
  domainName: string,
  webRoot: string
): Promise<VhostResult> {
  const response: TypedResponse<ApiActionResponse<VhostResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/vhostCreate',
      {
        authToken: token,
        vhost: {
          domainName,
          serverType: 'nginx',
          webspaceId: webspace.id,
          enableAlias: false,
          additionalDomainNames: web.alias ?? [],
          enableSystemAlias: web.previewDomain ?? false,
          redirectToPrimaryName: web.redirect ?? true,
          phpVersion: app.php?.version,
          webRoot: `${webRoot}/current/${web.root ?? ''}`.replace(/\/$/, ''),
          locations: Object.entries(web.locations ?? {}).map(function ([
            matchString,
            location
          ]) {
            return {
              matchString,
              matchType: matchString.startsWith('^')
                ? 'regex'
                : matchString.startsWith('/')
                  ? 'directory'
                  : 'default',
              locationType:
                location.allow ?? true ? 'location' : 'denyLocation',
              mapScript:
                typeof (location.passthru ?? false) === 'string'
                  ? location.passthru
                  : '',
              phpEnabled: false !== (location.passthru ?? false)
            }
          }),
          sslSettings: {
            profile: 'modern',
            managedSslProductCode: 'ssl-letsencrypt-dv-3m'
          }
        },
        phpIni: transformPhpIni(app.php?.ini ?? {})
      }
    )

  if (null === response.result) {
    throw new Error('Unexpected error')
  }

  return response.result.response
}
