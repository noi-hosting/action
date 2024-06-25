// noinspection ExceptionCaughtLocallyJS

import * as core from '@actions/core'
import * as services from './services'
import * as process from 'node:process'
import { config } from '../config'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // https://github.com/actions/toolkit/issues/1315
    const ref = process.env.GITHUB_REF_NAME ?? 'na'
    const appKey: string = core.getInput('app', { required: true })
    const projectPrefix: string = core.getInput('project-prefix', {
      required: true
    })
    const webspaceName: string = `${projectPrefix}-${ref}-${appKey}`.trim()
    const databasePrefix: string = `${projectPrefix}-${ref}`.trim()
    const { manifest, app, envVars: env1 } = await config(appKey)
    if (null === app) {
      throw new Error(
        `Cannot find "applications.${appKey}" in the ".hosting/config.yaml" manifest.`
      )
    }

    const {
      webspace,
      isNew: isNewWebspace,
      sshHost,
      sshUser,
      httpUser,
      envVars: env2
    } = await services.getWebspace(webspaceName, app)

    const { destinations, phpVersion, phpExtensions } =
      await services.applyVhosts(webspace, app, manifest, ref, appKey, httpUser)
    const { newDatabases, envVars: env3 } = await services.applyDatabases(
      databasePrefix,
      appKey,
      app,
      manifest
    )

    core.setOutput('sync-files', isNewWebspace)
    core.setOutput('sync-databases', newDatabases.join(' '))
    core.setOutput('ssh-user', sshUser)
    core.setOutput('ssh-host', sshHost)
    core.setOutput('ssh-port', 2244)
    core.setOutput('http-user', httpUser)
    core.setOutput('php-version', phpVersion)
    core.setOutput('php-extensions', phpExtensions.join(', '))
    core.setOutput('env-vars', Object.assign(env1, env2, env3))
    core.setOutput('deploy-path', destinations[0].deployPath)
    core.setOutput('public-url', destinations[0].publicUrl)

    if (manifest.project?.prune ?? true) {
      await services.pruneBranches(projectPrefix)
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
