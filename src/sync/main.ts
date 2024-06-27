// noinspection ExceptionCaughtLocallyJS

import * as core from '@actions/core'
import { exec } from '@actions/exec'
import * as client from '../api-client'
import { readConfig } from '../config'
import crypto from 'crypto'
import { findDatabases } from '../api-client'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const appKey: string = core.getInput('app', {
      required: false
    })
    const projectPrefix: string = core.getInput('project-prefix', {
      required: true
    })
    const shallSyncFiles: boolean = 'false' !== core.getInput('files')
    const shallSyncDatabases: boolean = 'false' !== core.getInput('databases')
    const syncDatabases: string[] = core.getInput('only-databases').split(' ')

    const { config, app } = await readConfig(appKey)

    let fromEnv = core.getInput('from', {
      required: false
    })
    const toEnv = core.getInput('to', {
      required: true
    })
    if ('' === fromEnv) {
      fromEnv = config.project.parent
    }

    if ('' === fromEnv || '' === toEnv) {
      core.info(
        'Sync destinations were not specified and cannot be derived. Please check the `project.parent` config in the ".hosting/config.yaml" file.'
      )
    }

    if (shallSyncFiles) {
      for (const [appName, app1] of Object.entries(config.applications)) {
        if ('' !== appKey && appName !== appKey) {
          continue
        }

        const fromWebspace = await client.findOneWebspaceByName(`${projectPrefix}-${fromEnv}-${appName}`)
        const toWebspace = await client.findOneWebspaceByName(`${projectPrefix}-${toEnv}-${appName}`)
        if (null === fromWebspace) {
          core.info(`The webspace for app ${appName} is not present in the ${fromEnv} environment. Skipping.`)
          continue
        }
        if (null === toWebspace) {
          continue
        }

        const dirs = Object.values(app1.sync)
        for (let dir of dirs) {
          dir = dir.trim().replace(/\/$/, '').replace(/^\//, '')
          const pathFrom = `/home/${fromWebspace.webspaceName}/html/current/${dir}`
          const pathTo = `/home/${toWebspace.webspaceName}/html/current/${dir}`

          await exec(
            `/bin/bash -c "ssh -p 2244 -R localhost:50000:${toWebspace.hostName}:2244 ${fromWebspace.hostName} 'rsync -e "ssh -p 50000" -azr --delete ${pathFrom} localhost:${pathTo}'"`
          )
        }
      }
    }

    if (!shallSyncDatabases) {
      return
    }

    core.info(`Syncing databases from environment "${fromEnv}" to environment "${toEnv}"`)

    const dbQueries: string[] = []
    if ('' === appKey) {
      if (syncDatabases.length > 0) {
        for (const dbName of syncDatabases) {
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
          (syncDatabases.length === 0 || syncDatabases.includes(d.split(':')[1] ?? appKey))
      )) {
        dbQueries.push(`${projectPrefix}-${fromEnv}-${dbName}`)
        dbQueries.push(`${projectPrefix}-${toEnv}-${dbName}`)
      }
    } else {
      throw new Error(`Cannot find "applications.${appKey}" in the ".hosting/config.yaml" file.`)
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
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
