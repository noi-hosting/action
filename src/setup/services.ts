import * as client from '../api-client'
import * as core from '@actions/core'
import process from 'node:process'
import { wait } from '../wait'
import * as _ from 'lodash'
import crypto from 'crypto'
import { Config, AppConfig, WebConfig } from '../config'
import {
  DatabaseResult,
  transformCronJob,
  VhostResult,
  WebspaceAccess,
  WebspaceResult,
  UserResult,
  getAccesses
} from '../api-client'

export async function getWebspace(
  webspaceName: string,
  app: AppConfig
): Promise<{
  webspace: WebspaceResult
  isNew: boolean
  sshUser: string
  sshHost: string
  httpUser: string
  envVars: {
    [key: string]: string | boolean | number
  }
}> {
  const { webspace, webspaceAccess, isNew } = await findOrCreateWebspace(webspaceName, app)
  const envVars: {
    [key: string]: string | boolean | number
  } = {}

  const redisRelationName = Object.keys(app.relationships).find(key => 'redis' === app.relationships[key]) ?? null
  if (null !== redisRelationName) {
    envVars[`${redisRelationName.replace('-', '_').toUpperCase()}_HOST`] =
      `/run/redis-${webspace.webspaceName}/sock`
    envVars[`${redisRelationName.replace('-', '_').toUpperCase()}_URL`] =
      `redis:///run/redis-${webspace.webspaceName}/sock`
  }

  return {
    webspace,
    isNew,
    sshUser: webspaceAccess.userName ?? '',
    sshHost: webspace.hostName,
    httpUser: webspace.webspaceName,
    envVars
  }
}

export async function applyVhosts(
  webspace: WebspaceResult,
  app: AppConfig,
  config: Config,
  ref: string,
  appKey: string,
  httpUser: string
): Promise<{
  destinations: Destination[]
  phpVersion: string
  phpExtensions: string[]
}> {
  const foundVhosts: VhostResult[] = await client.findVhostByWebspace(webspace.id)

  const destinations = []
  const phpVersion = app.php.version
  const phpExtensions = app.php.extensions

  for (const web of app.web) {
    const { domainName } = await configureVhosts(web, app, ref, config, appKey, foundVhosts, webspace, phpVersion)

    destinations.push({
      deployPath: `/home/${httpUser}/html`,
      publicUrl: `https://${domainName}`
    })
  }

  await pruneVhosts(foundVhosts, app, ref, config, appKey)

  return {
    destinations,
    phpVersion,
    phpExtensions
  }
}

export async function applyDatabases(
  databasePrefix: string,
  appKey: string,
  app: AppConfig,
  config: Config
): Promise<{
  newDatabases: string[]
  envVars: {
    [key: string]: string | boolean | number
  }
}> {
  const envVars = {}
  const foundDatabases = await client.findDatabases(`${databasePrefix}-*`)

  const { newDatabases } = await configureDatabases(config, app, databasePrefix, appKey, foundDatabases, envVars)
  await pruneDatabases(config, databasePrefix, foundDatabases)

  return {
    newDatabases,
    envVars
  }
}

export async function findOrCreateWebspace(
  webspaceName: string,
  app: AppConfig
): Promise<{
  webspace: WebspaceResult
  webspaceAccess: WebspaceAccess
  isNew: boolean
}> {
  const redisEnabled = Object.values(app.relationships).includes('redis')
  let webspace: WebspaceResult | null = await client.findOneWebspaceByName(webspaceName)

  const additionalUsers = []
  for (const [displayName, key] of Object.entries(app.users)) {
    if (!key.startsWith('ssh-rsa ') || key.split(' ').length > 3) {
      console.error(`SSH key under "${displayName} is not supported`)
      continue
    }

    const fingerprint = crypto.createHash('sha512').update(key).digest('hex')
    additionalUsers.push({
      displayName: `${displayName} #${fingerprint.substring(0, 6)}#`,
      key
    })
  }

  const availUsers = await client.findUsersByName(
    [`github-action--${webspaceName}`].concat(additionalUsers.map(x => x.displayName))
  )

  let ghUser = availUsers.find(u => u.name === `github-action--${webspaceName}`) ?? null
  const users: UserResult[] = []
  if (null === ghUser) {
    ghUser = await client.createWebspaceUser(
      `github-action--${webspaceName}`,
      core.getInput('ssh-public-key', {
        required: true
      })
    )
  }

  users.push(ghUser)

  for (const user of additionalUsers) {
    const u = availUsers.find(x => x.name === user.displayName) ?? null
    if (null !== u) {
      users.push(u)
    } else {
      users.push(await client.createWebspaceUser(user.displayName, user.key))
    }
  }

  if (null !== webspace) {
    if (
      // Cronjobs are unchanged
      _.isEqual(
        webspace.cronJobs,
        app.cron.map(c => transformCronJob(c, app.php.version))
      ) &&
      // Redis is unchanged
      _.isEqual(redisEnabled, webspace.redisEnabled ?? false) &&
      // Webspace users are unchanged
      _.isEqual(
        webspace.accesses.map(a => a.userId),
        availUsers.map(u => u.id)
      )
    ) {
      core.info(`Using webspace ${webspaceName} (${webspace.id})`)
    } else {
      core.info(`Updating webspace ${webspaceName} (${webspace.id})`)

      webspace = await client.updateWebspace(webspace, users, app.php.version, app.cron, redisEnabled)
    }

    const webspaceAccess = webspace.accesses.find(a => (ghUser.id = a.userId)) ?? null
    if (null === webspaceAccess) {
      throw new Error(`Unexpected error`)
    }

    return {
      webspace,
      webspaceAccess,
      isNew: false
    }
  }

  core.info('Creating a new webspace...')

  webspace = await client.createWebspace(
    webspaceName,
    users,
    app.cron,
    app.php.version,
    app.pool,
    app.account,
    redisEnabled
  )

  do {
    await wait(2000)
    core.info(`Waiting for webspace ${webspaceName} (${webspace.id}) to boot...`)
    webspace = await client.findWebspaceById(webspace.id)
    if (null === webspace) {
      throw new Error(`Unexpected error.`)
    }
  } while ('active' !== webspace.status)

  const webspaceAccess = webspace.accesses.find(a => (ghUser.id = a.userId)) ?? null
  if (null === webspaceAccess) {
    throw new Error(`Unexpected error`)
  }

  return {
    webspace,
    webspaceAccess,
    isNew: true
  }
}

export async function getWebspaceAccess(webspace: WebspaceResult): Promise<WebspaceAccess> {
  const availableUsers = await client.findUsersByName('github-action--*')
  const webspaceAccess = webspace.accesses.find(a => availableUsers.find(u => u.id === a.userId)) ?? null

  if (null === webspaceAccess) {
    throw new Error(`It seems that the SSH access to the webspace was revoked for the github-action.`)
  }

  return webspaceAccess
}

export async function configureVhosts(
  web: WebConfig,
  app: AppConfig,
  ref: string,
  config: Config,
  appKey: string,
  foundVhosts: VhostResult[],
  webspace: WebspaceResult,
  phpVersion: string
): Promise<{
  domainName: string
}> {
  const actualDomainName = translateDomainName(web.domainName ?? null, ref, config, appKey)

  let vhost = foundVhosts.find(v => v.domainName === actualDomainName) ?? null
  if (null === vhost) {
    core.info(`Configuring ${actualDomainName}...`)
    vhost = await client.createVhost(webspace, web, app, actualDomainName, phpVersion)
  } else if (mustBeUpdated(vhost, app, web)) {
    core.info(`Configuring ${actualDomainName}...`)
    // todo
  }

  return {
    domainName: actualDomainName
  }
}

export async function pruneVhosts(
  foundVhosts: VhostResult[],
  app: AppConfig,
  ref: string,
  config: Config,
  appKey: string
): Promise<void> {
  for (const relict of foundVhosts.filter(
    v =>
      !Object.keys(app.web)
        .map(domainName => translateDomainName(domainName, ref, config, appKey))
        .includes(v.domainName)
  )) {
    core.info(`Deleting ${relict.domainName}...`)

    await client.deleteVhostById(relict.id)
  }
}

export async function configureDatabases(
  config: Config,
  app: AppConfig,
  databasePrefix: string,
  appKey: string,
  foundDatabases: DatabaseResult[],
  envVars: object
): Promise<{
  newDatabases: string[]
}> {
  const newDatabases = []
  for (const [relationName, relation] of Object.entries(app.relationships).filter(
    ([, v]) => 'database' === v.split(':')[0]
  )) {
    const endpointName = relation.split(':')[1] ?? appKey
    const endpoint = config.databases?.endpoints[endpointName] ?? null
    if (null === endpoint) {
      throw new Error(`Could not find "databases.endpoint.${endpointName}"`)
    }
    const [schema, privileges] = endpoint.split(':')
    if (!(config.databases?.schemas ?? []).includes(schema)) {
      throw new Error(`Could not find schema "${schema}" under "databases.schemas"`)
    }

    const databaseInternalName = `${databasePrefix}-${schema.toLowerCase()}`
    const dbUserName = `${databasePrefix}-${endpointName.toLowerCase()}--${appKey}`

    core.info(`Processing database "${schema}" for relation "${relationName}"`)

    const existingDatabase = foundDatabases.find(d => d.name === databaseInternalName) ?? null
    if (null !== existingDatabase) {
      const usersWithAccess = await client.findDatabaseAccesses(dbUserName, existingDatabase.id)
      if (usersWithAccess.length) {
        core.info(`Database already in use (${databaseInternalName})`)

        const access = existingDatabase.accesses.find(a => a.userId === usersWithAccess[0].id)
        if ((privileges ?? 'admin') !== getPrivileges(access?.accessLevel ?? [])) {
          await client.updateDatabase(
            existingDatabase,
            existingDatabase.accesses.map(a => {
              if (a.userId === usersWithAccess[0].id) {
                a.accessLevel = getAccesses(privileges ?? 'admin')
              }
              return a
            })
          )
        }
      } else {
        core.info(`Granting access on database ${databaseInternalName}`)

        const { user: dbUser, password: databasePassword } = await client.createDatabaseUser(dbUserName, app.account)
        const { database, dbLogin } = await client.addDatabaseAccess(existingDatabase, dbUser, privileges ?? '')

        defineEnv(envVars, relationName, database, dbLogin, databasePassword)
      }
    } else {
      core.info(`Creating database ${databaseInternalName}`)

      const {
        database: createdDatabase,
        databaseUserName,
        databasePassword
      } = await client.createDatabase(dbUserName, databaseInternalName, app.pool ?? null)

      let database: DatabaseResult | null = createdDatabase
      do {
        await wait(2000)
        core.info(`Waiting for database ${databaseInternalName} to come up...`)
        database = await client.findDatabaseById(database.id)
        if (null === database) {
          throw new Error(`Unexpected error.`)
        }
      } while ('active' !== database.status)

      newDatabases.push(schema)

      defineEnv(envVars, relationName, database, databaseUserName, databasePassword)
    }
  }

  return {
    newDatabases
  }
}

function defineEnv(
  envVars: object,
  relationName: string,
  database: DatabaseResult,
  databaseUserName: string,
  databasePassword: string
): void {
  Object.assign(
    envVars,
    Object.fromEntries([
      [`${relationName.toUpperCase()}_SERVER`, `mysql://${database.hostName}`],
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

export async function pruneDatabases(
  config: Config,
  databasePrefix: string,
  foundDatabases: DatabaseResult[]
): Promise<void> {
  const allDatabaseNames = config.databases?.schemas ?? []
  for (const relict of foundDatabases.filter(
    v => !allDatabaseNames.map(n => `${databasePrefix}-${n.toLowerCase()}`).includes(v.name)
  )) {
    core.info(`Deleting database ${relict.name}`)

    await client.deleteDatabaseById(relict.id)
  }
}

export async function pruneBranches(projectPrefix: string): Promise<void> {
  const branches = (process.env.REPO_BRANCHES ?? '').split(' ')
  if (branches.length < 2) {
    return
  }

  const allWebspaces = await client.findActiveWebspaces(projectPrefix)
  for (const webspace of allWebspaces) {
    const match = webspace.name.match(/\w+-(.+)-\w+/)
    if (null === match) {
      continue
    }

    if (!branches.includes(match[1])) {
      core.info(`Deleting webspace ${webspace.name}`)
      await client.deleteWebspaceById(webspace.id)

      const databases = await client.findDatabases(`${projectPrefix}-${match[1]}-*`.trim())
      for (const d of databases) {
        core.info(`Deleting database ${d.name}`)
        await client.deleteDatabaseById(d.id)
      }
    }
  }
}

function translateDomainName(domainName: string | null, environment: string, config: Config, app: string): string {
  if (null === domainName) {
    domainName = process.env.DOMAIN_NAME ?? ''
  }

  const previewDomain = config.project.domain ?? null
  if (null !== previewDomain && ('' === domainName || environment !== (config.project?.parent ?? ''))) {
    domainName = previewDomain
  }

  if ('' === domainName) {
    throw new Error(
      `No domain name configured for the app defined under "applications.${app}". ` +
        `Please provide the a variable named "DOMAIN_NAME" under Github's environment settings. ` +
        `Alternatively, set the domain name via "applications.${app}.web.locations[].domainName".`
    )
  }
  // POC
  // if (null !== (web.environments ?? null) && environment in web.environments) {
  //   return web.environments[environment]
  // }

  return domainName.replace(/\{app}/gi, app).replace(/\{ref}/gi, environment)
}

function getPrivileges(accessLevel: string[]): string {
  if (accessLevel.includes('read') && accessLevel.includes('write') && accessLevel.includes('schema')) {
    return 'admin'
  }
  if (accessLevel.includes('read') && accessLevel.includes('write')) {
    return 'rw'
  }
  if (accessLevel.includes('read')) {
    return 'r'
  }

  throw new Error(`Access level "${JSON.stringify(accessLevel)}" unknown.`)
}

function mustBeUpdated(vhost: VhostResult, app: AppConfig, web: WebConfig): boolean {
  if (app.php.version !== vhost.phpVersion) {
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

interface Destination {
  deployPath: string
  publicUrl: string
}
