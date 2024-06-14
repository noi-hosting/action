// noinspection ExceptionCaughtLocallyJS

import * as core from '@actions/core'
// import * as github from '@actions/github'
import { wait } from './wait'
import crypto from 'crypto'
import { HttpClient } from '@actions/http-client'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import { TypedResponse } from '@actions/http-client/lib/interfaces'
import * as process from 'node:process'

const _http = new HttpClient()
const token = core.getInput('auth-token', { required: true })

interface Manifest {
  project?: {
    parent?: string
    domain?: string
    prune?: boolean
  }
  applications: {
    [app: string]: ManifestApp
  }
}

interface ManifestApp {
  pool?: string
  account?: string
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
  root?: string
  www?: boolean
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

interface DatabaseAccess {
  addDate?: string
  lastChangeDate?: string
  accessLevel: string[]
  userId: string
  dbLogin?: string
  userName?: string
  databaseId?: string
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

interface UserResult {
  id: string
  accountId: string
  addDate: string
  comments: string
  lastChangeDate: string
  name: string
  status: string
}

interface WebspaceUserResult extends UserResult {
  sshKey: string
  userName: string
}

interface DatabaseUserResult extends UserResult {
  dbUserName: string
}

interface VhostResult {
  id: string
  domainName: string
  additionalDomainNames: string[]
  enableAlias: boolean
  redirectToPrimaryName: boolean
  redirectHttpToHttps: boolean
  enableSystemAlias: boolean
  systemAlias: string
  webRoot: string
  phpVersion: string
  serverType: string
  httpUsers: object[]
  locations: object[]
  sslSettings: object
}

interface DatabaseResult {
  id: string
  accesses: DatabaseAccess[]
  bundleId: string | null
  poolId: string | null
  accountId: string
  addDate: string
  paidUntil: string
  renewOn: string
  deletionScheduledFor: string | null
  lastChangeDate: string
  name: string
  comments: string
  productCode: string
  restorableUntil: string | null
  status: string
  storageQuota: number
  storageQuotaIncluded: number
  storageQuotaUsedRatio: number
  storageUsed: number
  dbName: string
  hostName: string
  dbEngine: string
  dbType: string
  forceSsl: boolean
  restrictions: string[]
  limitations: string[]
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // https://github.com/actions/toolkit/issues/1315
    const ref = process.env.GITHUB_REF_NAME ?? 'na'
    const appKey: string = core.getInput('app', { required: true })
    const projectPrefix: string = core.getInput('webspace-prefix', {
      required: true
    })
    const webspaceName: string = `${projectPrefix}-${ref}-${appKey}`.trim()
    const databasePrefix: string = `${projectPrefix}-${ref}`.trim()
    const manifest: Manifest = yaml.load(
      fs.readFileSync('./.hosting/config.yaml', 'utf8')
    ) as Manifest
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
      core.info(`Using webspace ${webspaceName} (${webspace.id})`)
      core.setOutput('shall-sync', false)
    } else {
      core.info('Creating a new webspace...')
      core.setOutput('shall-sync', true)
      webspace = await createWebspace(app, webspaceName)

      do {
        await wait(2000)
        core.info(
          `Waiting for webspace ${webspaceName} (${webspace.id}) to boot...`
        )
        foundWebspace = await findWebspaceById(webspace.id)
        if (null === foundWebspace) {
          break
        }
        webspace = foundWebspace
      } while ('active' !== webspace.status)
    }

    const availableUsers = await findWebspaceUsers()
    const webspaceAccess: WebspaceAccess | null =
      webspace.accesses.find(a =>
        availableUsers.find(u => u.id === a.userId)
      ) ?? null
    if (null === webspaceAccess) {
      throw new Error(
        `It seems that the SSH access to the webspace was revoked for the github-action.`
      )
    }

    const sshUser = webspaceAccess.userName
    const sshHost = webspace.hostName
    const httpUser = webspace.webspaceName

    core.setOutput('ssh-user', sshUser)
    core.setOutput('ssh-host', sshHost)
    core.setOutput('ssh-port', 2244)
    core.setOutput('http-user', httpUser)

    const foundVhosts: VhostResult[] = await findVhostByWebspace(webspace.id)
    for (const [domainName, web] of Object.entries(app.web)) {
      const actualDomainName = translateDomainName(
        domainName,
        ref,
        manifest,
        appKey
      )

      let vhost =
        foundVhosts.find(v => v.domainName === actualDomainName) ?? null
      if (null === vhost) {
        core.info(`Configuring ${actualDomainName}...`)
        vhost = await createVhost(webspace, web, app, actualDomainName)
      } else if (mustBeUpdated(vhost, app, web)) {
        core.info(`Configuring ${actualDomainName}...`)
        // todo
      }

      core.setOutput('deploy-path', `/home/${httpUser}/html`)
      core.setOutput('public-url', `https://${vhost.domainName}`)
    }

    for (const relict of foundVhosts.filter(
      v =>
        !Object.keys(app.web)
          .map(domainName =>
            translateDomainName(domainName, ref, manifest, appKey)
          )
          .includes(v.domainName)
    )) {
      core.info(`Deleting ${relict.domainName}...`)

      await deleteVhostById(relict.id)
    }

    const envVars = {}

    const foundDatabases = await findDatabasesByWebspace(databasePrefix)
    for (const [relationName, databaseName] of Object.entries(
      app.databases ?? {}
    )) {
      const databaseInternalName = `${databasePrefix}-${databaseName.toLowerCase()}`
      const dbUserName = `${databasePrefix}-${appKey}--${relationName.toLowerCase()}`

      const existingDatabase =
        foundDatabases.find(d => d.name === databaseInternalName) ?? null
      if (null !== existingDatabase) {
        const usersWithAccess = await findDatabaseAccesses(
          dbUserName,
          existingDatabase.id
        )
        if (!usersWithAccess.length) {
          core.info(`Granting access on database ${databaseInternalName}`)

          const { database, databaseUserName, databasePassword } =
            await addDatabaseAccess(existingDatabase, dbUserName, app)

          Object.assign(
            envVars,
            Object.fromEntries([
              [
                `${relationName.toUpperCase()}_SERVER`,
                `mysql://${database.hostName}`
              ],
              [`${relationName.toUpperCase()}_DRIVER`, 'mysql'],
              [`${relationName.toUpperCase()}_HOST`, database.hostName],
              [`${relationName.toUpperCase()}_PORT`, 3306],
              [`${relationName.toUpperCase()}_NAME`, database.dbName],
              [`${relationName.toUpperCase()}_USERNAME`, databaseUserName],
              [`${relationName.toUpperCase()}_PASSWORD`, databasePassword],
              [
                `${relationName.toUpperCase()}_URL`,
                `mysql://${databaseUserName}:${encodeURIComponent(databasePassword)}@${database.hostName}:3306/${database.dbName}`
              ]
            ])
          )

          core.setSecret(databaseUserName)
          core.setSecret(databasePassword)
        }
      } else {
        core.info(`Creating database ${databaseInternalName}`)

        const { database, databaseUserName, databasePassword } =
          await createDatabase(app, dbUserName, databaseInternalName)

        Object.assign(
          envVars,
          Object.fromEntries([
            [
              `${relationName.toUpperCase()}_SERVER`,
              `mysql://${database.hostName}`
            ],
            [`${relationName.toUpperCase()}_DRIVER`, 'mysql'],
            [`${relationName.toUpperCase()}_HOST`, database.hostName],
            [`${relationName.toUpperCase()}_PORT`, 3306],
            [`${relationName.toUpperCase()}_NAME`, database.dbName],
            [`${relationName.toUpperCase()}_USERNAME`, databaseUserName],
            [`${relationName.toUpperCase()}_PASSWORD`, databasePassword],
            [
              `${relationName.toUpperCase()}_URL`,
              `mysql://${databaseUserName}:${encodeURIComponent(databasePassword)}@${database.hostName}:3306/${database.dbName}`
            ]
          ])
        )

        core.setSecret(databaseUserName)
        core.setSecret(databasePassword)
      }
    }

    const allDatabaseNames = Object.values(manifest.applications).reduce(
      (dbNames, a) => dbNames.concat(Object.values(a.databases ?? {})),
      [] as string[]
    )
    for (const relict of foundDatabases.filter(
      v =>
        !allDatabaseNames
          .map(n => `${databasePrefix}-${n.toLowerCase()}`)
          .includes(v.name)
    )) {
      core.info(`Deleting database ${relict.name}`)

      await deleteDatabaseById(relict.id)
    }

    core.setOutput('env-vars', envVars)

    const branches = (process.env.REPO_BRANCHES ?? '').split(' ')
    const allWebspaces = await findWebspaces(projectPrefix)
    if ((manifest.project?.prune ?? true) && branches) {
      for (const w of allWebspaces) {
        const m = w.name.match(/\w+-(.+)-\w+/)
        core.info(JSON.stringify(m))
        if (null === m) {
          continue
        }

        if (!branches.includes(m[0])) {
          core.info(`Deleting webspace ${webspace.name}`)
        } else {
          core.info(`Keeping webspace ${webspace.name}`)
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

function translateDomainName(
  domainName: string,
  environment: string,
  manifest: Manifest,
  app: string
): string {
  if ('_' === domainName) {
    domainName = process.env.DOMAIN_NAME ?? ''
  }

  const previewDomain = manifest.project?.domain ?? null
  if (
    null !== previewDomain &&
    ('' === domainName || environment !== (manifest.project?.parent ?? ''))
  ) {
    domainName = previewDomain
  }

  if ('' === domainName) {
    throw new Error(
      `No domain name configured for the app defined under "applications.${app}". ` +
        `Please provide the variable "DOMAIN_NAME" under Github's environment settings. ` +
        `Alternatively, set the domain name via "applications.${app}.web.locations[_]".`
    )
  }
  // POC
  // if (null !== (web.environments ?? null) && environment in web.environments) {
  //   return web.environments[environment]
  // }

  return domainName.replace(/\{app}/gi, app).replace(/\{ref}/gi, environment)
}

function mustBeUpdated(
  vhost: VhostResult,
  app: ManifestApp,
  web: ManifestAppWeb
): boolean {
  const phpv = phpVersion(app)
  if (phpv && phpv !== vhost.phpVersion) {
    return true
  }

  // todo phpini

  if ((web.www ?? true) !== vhost.enableAlias) {
    return true
  }

  if (`current/${web.root ?? ''}`.replace(/\/$/, '') !== vhost.webRoot) {
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
          subFilterConnective: 'AND',
          subFilter: [
            {
              field: 'webspaceName',
              value: webspaceName
            },
            {
              field: 'webspaceStatus',
              value: 'active'
            }
          ]
        }
      }
    )
  if ((response.result?.response?.totalEntries ?? 0) > 1) {
    throw new Error(
      `We found more than 1 webspace with name "${webspaceName}" and cannot know where to deploy to.`
    )
  }

  return response.result?.response?.data[0] ?? null
}
async function findWebspaces(prefix: string): Promise<WebspaceResult[]> {
  const response: TypedResponse<ApiFindResponse<WebspaceResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/webspacesFind',
      {
        authToken: token,
        filter: {
          subFilterConnective: 'AND',
          subFilter: [
            {
              field: 'webspaceName',
              value: `${prefix}-*`
            },
            {
              field: 'webspaceStatus',
              value: 'active'
            }
          ]
        }
      }
    )

  return response.result?.response?.data ?? []
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

async function deleteDatabaseById(databaseId: string): Promise<void> {
  await _http.postJson(
    'https://secure.hosting.de/api/database/v1/json/databaseDelete',
    {
      authToken: token,
      databaseId
    }
  )
}

async function findVhostByWebspace(webspaceId: string): Promise<VhostResult[]> {
  const response: TypedResponse<ApiFindResponse<VhostResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/vhostsFind',
      {
        authToken: token,
        filter: {
          subFilterConnective: 'AND',
          subFilter: [
            {
              field: 'webspaceId',
              value: webspaceId
            },
            {
              field: 'vHostStatus',
              value: 'active'
            }
          ]
        }
      }
    )

  return response.result?.response?.data ?? []
}

async function findDatabaseAccesses(
  userName: string,
  databaseId: string
): Promise<DatabaseUserResult[]> {
  const response: TypedResponse<ApiFindResponse<DatabaseUserResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/database/v1/json/usersFind',
      {
        authToken: token,
        filter: {
          subFilterConnective: 'AND',
          subFilter: [
            {
              field: 'userName',
              value: userName
            },
            {
              field: 'userAccessesDatabaseId',
              value: databaseId
            }
          ]
        }
      }
    )

  return response.result?.response?.data ?? []
}

async function findDatabasesByWebspace(
  databasePrefix: string
): Promise<DatabaseResult[]> {
  const response: TypedResponse<ApiFindResponse<DatabaseResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/database/v1/json/databasesFind',
      {
        authToken: token,
        filter: {
          subFilterConnective: 'AND',
          subFilter: [
            {
              field: 'databaseName',
              value: `${databasePrefix}-*`
            },
            {
              field: 'databaseStatus',
              value: 'active'
            }
          ]
        }
      }
    )

  return response.result?.response?.data ?? []
}

async function findWebspaceUsers(): Promise<WebspaceUserResult[]> {
  const response: TypedResponse<ApiFindResponse<WebspaceUserResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/usersFind',
      {
        authToken: token,
        filter: {
          field: 'userName',
          value: 'github-action--*'
        }
      }
    )

  return response.result?.response?.data ?? []
}

async function createWebspace(
  manifest: ManifestApp,
  name: string
): Promise<WebspaceResult> {
  const user = await createWebspaceUser(name)

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
          cronJobs: [],
          accountId: manifest.account ?? null
        },
        accesses: [
          {
            userId: user.id,
            sshAccess: true
          }
        ],
        poolId: manifest.pool ?? null
      }
    )

  if (null === response.result) {
    throw new Error('Unexpected error')
  }

  if ('error' === (response.result.status ?? null)) {
    throw new Error(JSON.stringify(response.result.errors ?? []))
  }

  return response.result.response
}

async function createDatabase(
  manifest: ManifestApp,
  dbUserName: string,
  databaseName: string
): Promise<{
  database: DatabaseResult
  databaseUserName: string
  databasePassword: string
}> {
  const { user, password } = await createDatabaseUser(dbUserName, manifest)

  const response: TypedResponse<ApiActionResponse<DatabaseResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/database/v1/json/databaseCreate',
      {
        authToken: token,
        database: {
          name: databaseName,
          comments:
            'Created by setup-hostingde github action. Please do not change name.',
          productCode: 'database-mariadb-single-v1-1m',
          storageQuota: 512,
          accountId: manifest.account ?? null
        },
        accesses: [
          {
            userId: user.id,
            accessLevel: ['read', 'write', 'schema']
          }
        ],
        poolId: manifest.pool ?? null
      }
    )

  if (null === response.result) {
    throw new Error('Unexpected error')
  }

  if ('error' === (response.result.status ?? null)) {
    throw new Error(JSON.stringify(response.result.errors ?? []))
  }

  const database = response.result.response
  const access = database.accesses.find(a => a.userId === user.id) ?? null

  return {
    database,
    databaseUserName: access?.dbLogin ?? '',
    databasePassword: password
  }
}

async function addDatabaseAccess(
  database: DatabaseResult,
  dbUserName: string,
  manifest: ManifestApp
): Promise<{
  database: DatabaseResult
  databaseUserName: string
  databasePassword: string
}> {
  const { user, password } = await createDatabaseUser(dbUserName, manifest)
  const accesses = database.accesses
  accesses.push({
    userId: user.id,
    databaseId: database.id,
    accessLevel: ['read', 'write', 'schema']
  })

  const response: TypedResponse<ApiActionResponse<DatabaseResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/database/v1/json/databaseUpdate',
      {
        authToken: token,
        database: {
          id: database.id,
          name: database.name,
          productCode: database.productCode,
          forceSsl: database.forceSsl,
          storageQuota: database.storageQuota,
          comments: database.comments
        },
        accesses
      }
    )

  if (null === response.result) {
    throw new Error('Unexpected error')
  }

  if ('error' === (response.result.status ?? null)) {
    throw new Error(JSON.stringify(response.result.errors ?? []))
  }

  const result = response.result.response
  const access = result.accesses.find(a => a.userId === user.id) ?? null

  return {
    database: result,
    databaseUserName: access?.dbLogin ?? '',
    databasePassword: password
  }
}

async function createWebspaceUser(
  webspaceName: string
): Promise<WebspaceUserResult> {
  const sshKey: string = core.getInput('ssh-public-key', { required: true })

  const response: TypedResponse<ApiActionResponse<WebspaceUserResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/webhosting/v1/json/userCreate',
      {
        authToken: token,
        user: {
          sshKey,
          name: `github-action--${webspaceName}`,
          comment:
            'Created by setup-hostingde github action. Please do not remove.'
        },
        password: crypto.randomUUID()
      }
    )

  if (null === response.result) {
    throw new Error('Unexpected error')
  }

  if ('error' === (response.result.status ?? null)) {
    throw new Error(JSON.stringify(response.result.errors ?? []))
  }

  return response.result.response
}

async function createDatabaseUser(
  dbUserName: string,
  manifest: ManifestApp
): Promise<{ user: DatabaseUserResult; password: string }> {
  const password = crypto.randomUUID()

  const response: TypedResponse<ApiActionResponse<DatabaseUserResult>> =
    await _http.postJson(
      'https://secure.hosting.de/api/database/v1/json/userCreate',
      {
        authToken: token,
        user: {
          name: dbUserName,
          comment:
            'Created by setup-hostingde github action. Please do not remove.',
          accountId: manifest.account ?? null
        },
        password
      }
    )

  if (null === response.result) {
    throw new Error('Unexpected error')
  }

  if ('error' === (response.result.status ?? null)) {
    throw new Error(JSON.stringify(response.result.errors ?? []))
  }

  return { user: response.result.response, password }
}

function transformPhpIni(ini: object): object {
  return Object.entries(ini).map(([k, v]) => ({ key: k, value: `${v}` }))
}

function phpVersion(app: ManifestApp): string | null {
  return app.php?.version ?? process.env.PHP_VERSION ?? null
}

async function createVhost(
  webspace: WebspaceResult,
  web: ManifestAppWeb,
  app: ManifestApp,
  domainName: string
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
          enableAlias: web.www ?? true,
          redirectToPrimaryName: true,
          redirectHttpToHttps: true,
          phpVersion: phpVersion(app),
          webRoot: `current/${web.root ?? ''}`.replace(/\/$/, ''),
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
              locationType: location.allow ?? true ? 'generic' : 'blockAccess',
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
        phpIni: {
          values: transformPhpIni(app.php?.ini ?? {})
        }
      }
    )

  if (null === response.result) {
    throw new Error('Unexpected error')
  }

  if ('error' === (response.result.status ?? null)) {
    throw new Error(JSON.stringify(response.result.errors ?? []))
  }

  return response.result.response
}
