import * as client from './api-client'
import * as core from '@actions/core'
import process from 'node:process'
import { wait } from './wait'
import { Manifest, ManifestApp, ManifestAppWeb } from './config'
import {
  DatabaseResult,
  VhostResult,
  WebspaceAccess,
  WebspaceResult
} from './api-client'

export async function getWebspace(
  webspaceName: string,
  app: ManifestApp
): Promise<{
  webspace: WebspaceResult
  sshUser: string
  sshHost: string
  httpUser: string
}> {
  const webspace = await findOrCreateWebspace(webspaceName, app)
  const webspaceAccess = await getWebspaceAccess(webspace)

  return {
    webspace,
    sshUser: webspaceAccess.userName,
    sshHost: webspace.hostName,
    httpUser: webspace.webspaceName
  }
}

export async function applyVhosts(
  webspace: WebspaceResult,
  app: ManifestApp,
  manifest: Manifest,
  ref: string,
  appKey: string,
  httpUser: string
): Promise<{ destinations: Destination[] }> {
  const foundVhosts: VhostResult[] = await client.findVhostByWebspace(
    webspace.id
  )

  const destinations = []

  for (const [domainKey, web] of Object.entries(app.web)) {
    const { domainName } = await configureVhosts(
      domainKey,
      web,
      app,
      ref,
      manifest,
      appKey,
      foundVhosts,
      webspace
    )

    destinations.push({
      deployPath: `/home/${httpUser}/html`,
      publicUrl: `https://${domainName}`
    })
  }

  await pruneVhosts(foundVhosts, app, ref, manifest, appKey)

  return { destinations }
}

export async function applyDatabases(
  databasePrefix: string,
  appKey: string,
  app: ManifestApp,
  manifest: Manifest
): Promise<{ envVars: { [key: string]: string | boolean | number } }> {
  const envVars = {}
  const foundDatabases = await client.findDatabasesByPrefix(databasePrefix)

  await configureDatabases(app, databasePrefix, appKey, foundDatabases, envVars)
  await pruneDatabases(manifest, databasePrefix, foundDatabases)

  return { envVars }
}

export async function findOrCreateWebspace(
  webspaceName: string,
  app: ManifestApp
): Promise<WebspaceResult> {
  let webspace: WebspaceResult | null =
    await client.findOneWebspaceByName(webspaceName)
  if (null !== webspace) {
    core.info(`Using webspace ${webspaceName} (${webspace.id})`)
    core.setOutput('shall-sync', false)

    return webspace
  }

  core.info('Creating a new webspace...')
  core.setOutput('shall-sync', true)

  const phpv = app.php?.version ?? process.env.PHP_VERSION ?? null

  webspace = await client.createWebspace(
    webspaceName,
    app.cron,
    phpv,
    app.pool ?? null,
    app.account ?? null
  )

  do {
    await wait(2000)
    core.info(
      `Waiting for webspace ${webspaceName} (${webspace.id}) to boot...`
    )
    webspace = await client.findWebspaceById(webspace.id)
    if (null === webspace) {
      throw new Error(`Unexpected error.`)
    }
  } while ('active' !== webspace.status)

  return webspace
}

export async function getWebspaceAccess(
  webspace: WebspaceResult
): Promise<WebspaceAccess> {
  const availableUsers = await client.findWebspaceUsers()
  const webspaceAccess =
    webspace.accesses.find(a => availableUsers.find(u => u.id === a.userId)) ??
    null

  if (null === webspaceAccess) {
    throw new Error(
      `It seems that the SSH access to the webspace was revoked for the github-action.`
    )
  }

  return webspaceAccess
}

export async function configureVhosts(
  domainName: string,
  web: ManifestAppWeb,
  app: ManifestApp,
  ref: string,
  manifest: Manifest,
  appKey: string,
  foundVhosts: VhostResult[],
  webspace: WebspaceResult
): Promise<{ domainName: string }> {
  const actualDomainName = translateDomainName(
    domainName,
    ref,
    manifest,
    appKey
  )

  let vhost = foundVhosts.find(v => v.domainName === actualDomainName) ?? null
  if (null === vhost) {
    core.info(`Configuring ${actualDomainName}...`)
    vhost = await client.createVhost(webspace, web, app, actualDomainName)
  } else if (mustBeUpdated(vhost, app, web)) {
    core.info(`Configuring ${actualDomainName}...`)
    // todo
  }

  return { domainName: actualDomainName }
}

export async function pruneVhosts(
  foundVhosts: VhostResult[],
  app: ManifestApp,
  ref: string,
  manifest: Manifest,
  appKey: string
): Promise<void> {
  for (const relict of foundVhosts.filter(
    v =>
      !Object.keys(app.web)
        .map(domainName =>
          translateDomainName(domainName, ref, manifest, appKey)
        )
        .includes(v.domainName)
  )) {
    core.info(`Deleting ${relict.domainName}...`)

    await client.deleteVhostById(relict.id)
  }
}

export async function configureDatabases(
  app: ManifestApp,
  databasePrefix: string,
  appKey: string,
  foundDatabases: DatabaseResult[],
  envVars: object
): Promise<void> {
  for (const [relationName, databaseName] of Object.entries(
    app.databases ?? {}
  )) {
    const databaseInternalName = `${databasePrefix}-${databaseName.toLowerCase()}`
    const dbUserName = `${databasePrefix}-${appKey}--${relationName.toLowerCase()}`

    core.info(
      `Processing database "${databaseName}" for relation "${relationName}"`
    )

    const existingDatabase =
      foundDatabases.find(d => d.name === databaseInternalName) ?? null
    if (null !== existingDatabase) {
      const usersWithAccess = await client.findDatabaseAccesses(
        dbUserName,
        existingDatabase.id
      )
      if (usersWithAccess.length) {
        core.info(`Database already in use (${databaseInternalName})`)
      } else {
        core.info(`Granting access on database ${databaseInternalName}`)

        const { database, databaseUserName, databasePassword } =
          await client.addDatabaseAccess(
            existingDatabase,
            dbUserName,
            app.account ?? null
          )

        defineEnv(
          envVars,
          relationName,
          database,
          databaseUserName,
          databasePassword
        )
      }
    } else {
      core.info(`Creating database ${databaseInternalName}`)

      const { database, databaseUserName, databasePassword } =
        await client.createDatabase(
          dbUserName,
          databaseInternalName,
          app.pool ?? null
        )

      defineEnv(
        envVars,
        relationName,
        database,
        databaseUserName,
        databasePassword
      )
    }
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
  manifest: Manifest,
  databasePrefix: string,
  foundDatabases: DatabaseResult[]
): Promise<void> {
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

      const databases = await client.findDatabasesByPrefix(
        `${projectPrefix}-${match[1]}`.trim()
      )
      for (const d of databases) {
        core.info(`Deleting database ${d.name}`)
        await client.deleteDatabaseById(d.id)
      }
    }
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
  const phpv = app.php?.version ?? process.env.PHP_VERSION ?? null
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

interface Destination {
  deployPath: string
  publicUrl: string
}
