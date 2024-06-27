import * as yaml from 'js-yaml'
import fs from 'fs'

export async function readConfig(appKey: string): Promise<{
  config: Config
  app: AppConfig | null
  envVars: {
    [key: string]: string | boolean | number
  }
}> {
  const config = Object.assign(
    {
      project: {
        prune: true
      }
    },
    yaml.load(fs.readFileSync('./.hosting/config.yaml', 'utf8')) as Config
  )

  let app = null
  if (appKey in config.applications) {
    app = Object.assign(
      {
        pool: null,
        account: null,
        php: {
          ini: {},
          extensions: []
        },
        env: {},
        relationships: {},
        web: {
          locations: {}
        },
        users: {},
        cron: [],
        sync: []
      },
      config.applications[appKey]
    )
  }

  const envVars = app?.env ?? {}

  return {
    config,
    app,
    envVars
  }
}

interface Config {
  project: {
    parent: string
    domain?: string
    prune: boolean
  }
  applications: {
    [app: string]: AppConfig
  }
  databases?: {
    schemas: string[]
    endpoints: {
      [endpoint: string]: string // 'schema:privileges' or 'schema'
    }
  }
}

interface AppConfig {
  pool: string | null
  account: string | null
  php: {
    version: string
    extensions: string[]
    ini: {
      [key: string]: string | boolean
    }
  }
  env: {
    [key: string]: string | boolean | number
  }
  relationships: {
    [key: string]: string
  }
  web: WebConfig[]
  sync: string[]
  cron: CronjobConfig[]
  users: {
    [displayName: string]: string
  }
}

interface WebConfig {
  root?: string
  domainName?: string
  www?: boolean
  locations: {
    [matchString: string]: {
      passthru?: string | boolean
      expires?: string
      allow?: boolean
    }
  }
}

interface CronjobConfig {
  php?: string
  cmd?: string
  every: string
  on: string
}

export { Config, AppConfig, WebConfig, CronjobConfig }
