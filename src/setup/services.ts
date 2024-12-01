import * as client from '../api-client'
import * as core from '@actions/core'
import { wait } from '../wait'
import * as _ from 'lodash'
import crypto from 'crypto'
import { Config, AppConfig, WebConfig, UsersConfig } from '../config'
import {
  DatabaseResult,
  transformCronJob,
  VhostResult,
  WebspaceAccess,
  WebspaceResult,
  UserResult
} from '../api-client'

export async function getWebspace(
  webspaceName: string,
  app: AppConfig,
  users: UsersConfig,
  pool: string | null
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
  const { webspace, webspaceAccess, isNew } = await findOrCreateWebspace(webspaceName, app, users, pool)
  const envVars: {
    [key: string]: string | boolean | number
  } = {}

  const redisRelationName = Object.keys(app.relationships).find(key => 'redis' === app.relationships[key]) ?? null
  if (null !== redisRelationName) {
    envVars[`${redisRelationName.replace('-', '_').toUpperCase()}_HOST`] = `/run/redis-${webspace.webspaceName}/sock`
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
  app: AppConfig,
  users: UsersConfig,
  pool: string | null
): Promise<{
  webspace: WebspaceResult
  webspaceAccess: WebspaceAccess
  isNew: boolean
}> {
  const redisEnabled = Object.values(app.relationships).includes('redis')
  let webspace: WebspaceResult | null = await client.findOneWebspaceByName(webspaceName)

  const additionalUsers: { displayName: string; fingerprint: string; key: string }[] = []
  for (const userName of app.users) {
    const user = users[userName] ?? null
    if (null === user) {
      console.error(`User "${userName} not found`)
      continue
    }

    if (!user.key.startsWith('ssh-rsa ') || user.key.split(' ').length > 3) {
      console.error(`SSH key under "${userName} is not supported`)
      continue
    }

    const requiredAccessRole = core.getInput('access-role-ssh') ? core.getInput('access-role-ssh') : 'contributor'
    if (!['admin', 'contributor'].includes(requiredAccessRole)) {
      console.error(`Access role "${requiredAccessRole} is not supported`)
      continue
    }

    if (requiredAccessRole === 'admin' && (user.role ?? 'contributor') !== 'admin') {
      continue
    }

    const fingerprint = crypto.createHash('sha1').update(user.key).digest('hex')
    additionalUsers.push({
      displayName: `${userName} #${fingerprint.substring(0, 5)}#`,
      fingerprint: fingerprint.substring(0, 5),
      key: user.key
    })
  }

  const availUsers = await client.findUsersByName(
    [`github-action--${webspaceName}`].concat(additionalUsers.map(x => x.displayName))
  )

  let ghUser = availUsers.find(u => u.name === `github-action--${webspaceName}`) ?? null
  const webspaceUsers: UserResult[] = []
  if (null === ghUser) {
    ghUser = await client.createWebspaceUser(
      `github-action--${webspaceName}`,
      core.getInput('ssh-public-key', {
        required: true
      })
    )
  }

  webspaceUsers.push(ghUser)

  for (const user of additionalUsers) {
    const u = availUsers.find(x => x.name.includes(`#${user.fingerprint}#`)) ?? null
    if (null !== u) {
      webspaceUsers.push(u)
    } else {
      webspaceUsers.push(await client.createWebspaceUser(user.displayName, user.key))
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

      webspace = await client.updateWebspace(webspace, webspaceUsers, app.php.version, app.cron, redisEnabled)
    }

    const webspaceAccess = webspace.accesses.find(a => ghUser?.id === a.userId) ?? null
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
    webspaceUsers,
    app.cron,
    app.php.version,
    pool,
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

  const webspaceAccess = webspace.accesses.find(a => ghUser?.id === a.userId) ?? null
  if (null === webspaceAccess) {
    throw new Error(`Unexpected error`)
  }

  return {
    webspace,
    webspaceAccess,
    isNew: true
  }
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
  const actualDomainName = translateDomainName(
    web.domainName ?? '{default}',
    ref,
    config,
    appKey,
    web.defaultDomainName ?? ''
  )

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
  const allowedDomainNames = app.web.map(web =>
    translateDomainName(web.domainName ?? '{default}', ref, config, appKey, web.defaultDomainName ?? '')
  )
  for (const relict of foundVhosts.filter(v => !allowedDomainNames.includes(v.domainName))) {
    core.info(`Deleting ${relict.domainName}...`)

    await client.deleteVhostById(relict.id)
    await wait(2000)
    await client.deleteRestorableVhostById(relict.id)
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

    const databaseInternalName = `${databasePrefix}-${schema}`
    const dbUserName = `${databasePrefix}-${endpointName}--${appKey}`

    core.info(`Processing database "${schema}" for relation "${relationName}"`)

    const existingDatabase = foundDatabases.find(d => d.name === databaseInternalName) ?? null
    if (null !== existingDatabase) {
      const usersWithAccess = await client.findDatabaseAccesses(`${dbUserName}.*`, existingDatabase.id)

      // Get current rotation
      let rotation = 0
      if (usersWithAccess.length) {
        const matchName = usersWithAccess[0].name.match(/\.v(\d+)$/)
        rotation = null === matchName ? 0 : (+matchName[1] ?? 0)
      }

      core.info(`Rotating access on database ${databaseInternalName}`)

      // Create rotated db user
      const { user: dbUser, password: databasePassword } = await client.createDatabaseUser(
        `${dbUserName}.v${++rotation}`,
        app.account
      )

      const { database, dbLogin } = await client.addDatabaseAccess(existingDatabase, dbUser, privileges ?? '')

      // Delete old db users
      for (const u of usersWithAccess.slice(1)) {
        await client.deleteDatabaseUserById(u.id)
      }

      defineEnv(envVars, relationName, database, dbLogin, databasePassword)
    } else {
      core.info(`Creating database ${databaseInternalName}`)

      const {
        database: createdDatabase,
        databaseUserName,
        databasePassword
      } = await client.createDatabase(`${dbUserName}.v1}`, databaseInternalName, config.project.pool)

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
  const branches = core.getInput('keep-branches').split(',')
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

      const dbUsers = await client.findDatabaseUsersByName(`${projectPrefix}-${match[1]}-*`.trim())
      for (const u of dbUsers) {
        core.info(`Deleting database user ${u.name}`)
        await client.deleteDatabaseUserById(u.id)
      }

      const users = await client.findUsersByName(`github-action--${projectPrefix}-${match[1]}`.trim())
      for (const u of users) {
        core.info(`Deleting webspace user ${u.userName}`)
        await client.deleteWebspaceUserById(u.id)
      }
    }
  }
}

function translateDomainName(
  domainName: string,
  environment: string,
  config: Config,
  app: string,
  defaultDomainName = ''
): string {
  if ('' === defaultDomainName) {
    defaultDomainName = core.getInput('default-domain-name')
  }

  const previewDomain = config.project.domain ?? null
  if ('' === defaultDomainName && null !== previewDomain) {
    defaultDomainName = previewDomain
  }

  if ('' === defaultDomainName) {
    throw new Error(
      `No domain name configured for the app defined under "applications.${app}". ` +
        `Please set the "default-domain-name" input (via environment variables). ` +
        `Alternatively, set the domain name via "applications.${app}.web.locations[].domainName".`
    )
  }
  // POC
  // if (null !== (web.environments ?? null) && environment in web.environments) {
  //   return web.environments[environment]
  // }

  return domainName
    .replace(/\{default}/gi, defaultDomainName)
    .replace(/\{app}/gi, app)
    .replace(/\{ref}/gi, environment)
    .replace(/\//gi, '--')
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
