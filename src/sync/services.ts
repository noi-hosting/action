import { AppConfig, Config } from '../config'
import * as client from '../api-client'
import * as core from '@actions/core'
import { exec } from '@actions/exec'
import crypto from 'crypto'
import { findDatabases } from '../api-client'

export async function syncFileMounts(
  config: Config,
  projectPrefix: string,
  fromEnv: string,
  toEnv: string,
  appToSync = ''
): Promise<void> {
  for (const [appName, app] of Object.entries(config.applications)) {
    if ('' !== appToSync && appName !== appToSync) {
      continue
    }

    const fromWebspace = await client.findOneWebspaceByName(`${projectPrefix}-${fromEnv}-${appName}`)
    const toWebspace = await client.findOneWebspaceByName(`${projectPrefix}-${toEnv}-${appName}`)

    if (null === fromWebspace) {
      core.info(`The webspace for app ${appName} is not present in the ${fromEnv} environment. Skipping.`)
      continue
    }

    if (null === toWebspace || fromWebspace.id === toWebspace.id) {
      continue
    }

    for (let dir of Object.values(app.sync)) {
      dir = dir.trim().replace(/\/$/, '').replace(/^\//, '')
      const pathFrom = `/home/${fromWebspace.webspaceName}/html/current/${dir}`
      const pathTo = `/home/${toWebspace.webspaceName}/html/current/${dir}`

      core.info(`Now syncing: ${pathFrom} to ${pathTo}`)

      await exec(
        `/bin/bash -c "ssh -p 2244 -R localhost:50000:${toWebspace.hostName}:2244 ${fromWebspace.hostName} 'rsync -e \\'ssh -p 50000\\' -azr --delete ${pathFrom} localhost:${pathTo}'"`
      )
    }
  }
}

export async function syncDatabases(
  projectPrefix: string,
  fromEnv: string,
  toEnv: string,
  app: AppConfig | null,
  appToSync = '',
  databasesToSync: string[] = []
): Promise<void> {
  const dbQueries: string[] = []

  if ('' === appToSync) {
    if (databasesToSync.length > 0) {
      for (const dbName of databasesToSync) {
        dbQueries.push(`${projectPrefix}-${fromEnv}-${dbName}`)
        dbQueries.push(`${projectPrefix}-${toEnv}-${dbName}`)
      }
    } else {
      dbQueries.push(`${projectPrefix}-${fromEnv}-*`)
      dbQueries.push(`${projectPrefix}-${toEnv}-*`)
    }
  } else if (null !== app) {
    for (const dbName of Object.values(app.relationships).filter(
      d =>
        'database' === d.split(':')[0] &&
        (databasesToSync.length === 0 || databasesToSync.includes(d.split(':')[1] ?? appToSync))
    )) {
      dbQueries.push(`${projectPrefix}-${fromEnv}-${dbName}`)
      dbQueries.push(`${projectPrefix}-${toEnv}-${dbName}`)
    }
  } else {
    throw new Error(`Cannot find "applications.${appToSync}" in the ".hosting/config.yaml" file.`)
  }

  if (!dbQueries.length) {
    return
  }

  const migrations: {
    [name: string]: {
      [direction: string]: {
        host: string
        user: string
        password: string
        name: string
        humanName: string
      }
    }
  } = {}

  const dbUsername = `gh${crypto.randomInt(1000000, 9999999)}`
  const { user: dbUser, password: dbPassword } = await client.createDatabaseUser(dbUsername)

  core.setSecret(dbPassword)

  const foundDatabases = await findDatabases(dbQueries)
  for (const db of foundDatabases) {
    const { dbLogin } = await client.addDatabaseAccess(db, dbUser)
    const dbHost = db.hostName
    const dbEnv = db.name.split('-')[1] ?? null
    const dbName = db.name.split('-')[2] ?? null

    let k
    if (dbEnv === fromEnv) {
      k = 'from'
    } else if (dbEnv === toEnv) {
      k = 'to'
    } else {
      throw new Error(`Unexpected database environment "${dbEnv}"`)
    }

    migrations[dbName] = migrations[dbName] || {}
    migrations[dbName][k] = {
      host: dbHost,
      user: dbLogin,
      password: dbPassword,
      name: db.dbName,
      humanName: db.name
    }
  }

  for (const migration of Object.values(migrations)) {
    if (!('from' in migration)) {
      core.info(
        `Found database "${migration.to.humanName}" but this database is not present in the "${fromEnv}" environment`
      )
      continue
    } else if (!('to' in migration)) {
      continue
    }

    core.info(`Database "${migration.to.humanName}" will be overridden using database "${migration.from.humanName}"`)

    const filename = `${crypto.randomUUID()}.sql`
    await exec(
      `/bin/bash -c "mysqldump -h ${migration.from.host} -u ${migration.from.user} -p${migration.from.password} ${migration.from.name} > ${filename}"`
    )
    await exec(
      `/bin/bash -c "mysql -h ${migration.to.host} -u ${migration.to.user} -p${migration.to.password} ${migration.to.name} < ${filename}"`
    )
  }

  await client.deleteDatabaseUserById(dbUser.id)
}
