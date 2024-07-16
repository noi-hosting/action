import * as yaml from 'js-yaml'
import * as _ from 'lodash'
import fs from 'fs'

export async function readConfig(appKey: string): Promise<{
  config: Config
  app: AppConfig | null
  users: UsersConfig
  envVars: {
    [key: string]: string | boolean | number
  }
}> {
  const config = _.merge(
    {
      project: {
        pool: null,
        prune: true
      },
      users: {}
    },
    yaml.load(fs.readFileSync('./.hosting/config.yaml', 'utf8')) as Config
  )

  let app = null
  if (appKey in config.applications) {
    app = _.merge(
      {
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
        users: [],
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
    users: config.users,
    envVars
  }
}

interface Config {
  project: {
    parent: string
    domain?: string
    prune: boolean
    pool: string | null
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
  users: string[]
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

interface UsersConfig {
  [userName: string]: {
    role: string
    key: string
  }
}

interface CronjobConfig {
  php?: string
  cmd?: string
  every: string
  on: string
}

export { Config, AppConfig, WebConfig, CronjobConfig, UsersConfig }
