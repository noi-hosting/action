// noinspection ExceptionCaughtLocallyJS

import * as core from '@actions/core'
import * as github from '@actions/github'
import * as services from './services'
import * as process from 'node:process'
import { readConfig } from '../config'
// import { TypedResponse } from '@actions/http-client/lib/interfaces'
// import { HttpClient } from '@actions/http-client'
import crypto from 'crypto'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // https://github.com/actions/toolkit/issues/1315
    const ref = process.env.GITHUB_REF_NAME ?? 'na'
    const appKey: string = core.getInput('app', { required: true })

    const uniqStr = `${github.context.repo.owner}/${github.context.repo.repo}-${github.context.workflow}`
    const uniqHandle = crypto.createHash('sha1').update(uniqStr).digest('hex').substring(0, 5)

    let projectPrefix: string = core.getInput('project-prefix')
    if ('' === projectPrefix) {
      projectPrefix = uniqHandle
    }

    const webspaceName = `${projectPrefix}-${ref}-${appKey}`
    const databasePrefix = `${projectPrefix}-${ref}`
    const { config, app, users, envVars: env1 } = await readConfig(appKey)
    if (null === app) {
      throw new Error(`Cannot find "applications.${appKey}" in the ".hosting/config.yaml" file.`)
    }

    // // Check license
    // let license = core.getInput('license', {
    //   required: true
    // })
    //
    // if ('' === license) {
    //   license = uniqHandle
    // }
    //
    // const _http = new HttpClient()
    // const response1: TypedResponse<any> = await _http.postJson(
    //     `https://console.noi-hosting.de/api/license`,
    //     {license}
    // )
    //
    // if ('licensee' in response1) {
    //   core.info(`noi-hosting/action is licensed for ${response1.licensee} and must only be used by them or their team. <https://www.noi-hosting.de/license>`)
    // } else if ('grace_count' in response1) {
    //   core.info(`noi-hosting/action in demo-mode. Deployments will fail after more than ${response1.grace_count} deployments. Buy license: <https://console.noi-hosting.de>`)
    // } else {
    //   throw new Error(`No license provided or license key "${license}" is invalid.`)
    // }

    // Export environment variables for build hook
    for (const [k, v] of Object.entries(env1)) {
      core.exportVariable(k, v)
    }

    const {
      webspace,
      isNew: isNewWebspace,
      sshHost,
      sshUser,
      httpUser,
      envVars: env2
    } = await services.getWebspace(webspaceName, app, users, config.project.pool)

    // await _http.postJson(
    //     `https://console.noi-hosting.de/api/register-preview-domain`,
    //     {
    //       license,
    //       ipv4: webspace.serverIpv4,
    //       ipv6: webspace.serverIpv6,
    //       name: uniqStr
    //     }
    // )

    const { destinations, phpVersion, phpExtensions } = await services.applyVhosts(
      webspace,
      app,
      config,
      ref,
      appKey,
      httpUser
    )
    const { newDatabases, envVars: env3 } = await services.applyDatabases(databasePrefix, appKey, app, config)

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

    if (config.project.prune) {
      await services.pruneBranches(projectPrefix)
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
