// noinspection ExceptionCaughtLocallyJS

import * as core from '@actions/core'
import { exec } from '@actions/exec'
import * as client from '../api-client'
import { config } from '../config'
import crypto from 'crypto'
import { findDatabases } from '../api-client'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const appKey: string = core.getInput('app', { required: false })
    const projectPrefix: string = core.getInput('project-prefix', {
      required: true
    })
    //const shallSyncFiles: boolean = !!core.getInput('files')
    const shallSyncDatabases: boolean = 'false' !== core.getInput('databases')
    const syncDatabases: string[] = core.getInput('databases').split(' ')

    const { manifest, app } = await config(appKey)

    let fromEnv = core.getInput('from', { required: false })
    const toEnv = core.getInput('to', { required: true })
    if ('' === fromEnv) {
      fromEnv = manifest.project?.parent ?? ''
    }

    if ('' === fromEnv || '' === toEnv) {
      core.info(
        'Sync destinations were not specified and cannot be derived. Please check the `project.parent` config in your manifest file.'
      )
    }

    if (!shallSyncDatabases) {
      return
    }

    core.info(
      `Syncing databases from environment "${fromEnv}" to environment "${toEnv}"`
    )

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
      for (const relationName of Object.values(app.databases ?? {}).filter(
        d => d.length === 0 || syncDatabases.includes(d)
      )) {
        dbQueries.push(`${projectPrefix}-${fromEnv}-${relationName}`)
        dbQueries.push(`${projectPrefix}-${toEnv}-${relationName}`)
      }
    } else {
      throw new Error(
        `Cannot find "applications.${appKey}" in the ".hosting/config.yaml" manifest.`
      )
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
    const { user: dbUser, password: dbPassword } =
      await client.createDatabaseUser(dbUsername)

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

      core.info(
        `Database "${migration.to.humanName}" will be overridden using database "${migration.from.humanName}"`
      )

      const filename = `${crypto.randomUUID()}.sql`
      await exec(
        `mysqldump -h ${migration.from.host} -u ${migration.from.user} -p'${migration.from.password}' ${migration.from.name} > ${filename}`
      )
      await exec(
        `mysql -h ${migration.to.host} -u ${migration.to.user} -p'${migration.to.password}' ${migration.to.name} < ${filename}`
      )
    }

    await client.deleteDatabaseUserById(dbUser.id)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
