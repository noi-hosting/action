// noinspection ExceptionCaughtLocallyJS

import * as core from '@actions/core'
import * as github from '@actions/github'
import { readConfig } from '../config'
import crypto from 'crypto'
import { syncDatabases, syncFileMounts } from './services'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const appKey: string = core.getInput('app', {
      required: false
    })
    const uniqStr = `${github.context.repo.owner}/${github.context.repo.repo}-${github.context.workflow}`
    const uniqHandle = crypto.createHash('sha1').update(uniqStr).digest('hex').substring(0, 5)

    let projectPrefix: string = core.getInput('project-prefix')
    if ('' === projectPrefix) {
      projectPrefix = uniqHandle
    }

    const shallSyncFiles: boolean = core.getBooleanInput('files')
    const shallSyncDatabases: boolean = core.getBooleanInput('databases')
    const databaseNames: string[] = core.getInput('limit-database').split(' ')

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

    if (fromEnv === toEnv) {
      return
    }

    if (shallSyncFiles) {
      core.info(`Syncing file mounts from environment "${fromEnv}" to environment "${toEnv}"`)

      await syncFileMounts(config, projectPrefix, fromEnv, toEnv, appKey)
    }

    if (shallSyncDatabases) {
      core.info(`Syncing databases from environment "${fromEnv}" to environment "${toEnv}"`)

      await syncDatabases(projectPrefix, fromEnv, toEnv, app, appKey, databaseNames)
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
