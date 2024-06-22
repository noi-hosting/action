import * as yaml from 'js-yaml'
import fs from 'fs'

export async function config(
  appKey: string
): Promise<{ manifest: Manifest; app: ManifestApp }> {
  const manifest = yaml.load(
    fs.readFileSync('./.hosting/config.yaml', 'utf8')
  ) as Manifest
  const app = manifest.applications[appKey] ?? null
  if (null === app) {
    throw new Error(
      `Cannot find "applications.${appKey}" in the ".hosting/config.yaml" manifest.`
    )
  }

  return { manifest, app }
}

interface Manifest {
  project?: {
    parent?: string
    domain?: string
    prune?: boolean
  }
  applications: {
    [app: string]: ManifestApp
  }
}

interface ManifestApp {
  pool?: string
  account?: string
  php?: {
    version?: string
    ini?: {
      [key: string]: string | boolean
    }
  }
  databases?: {
    [key: string]: string
  }
  web: {
    [domainName: string]: ManifestAppWeb
  }
}

interface ManifestAppWeb {
  root?: string
  www?: boolean
  locations: {
    [matchString: string]: {
      passthru?: string | boolean
      expires?: boolean
      allow?: boolean
    }
  }
}

export { Manifest, ManifestApp, ManifestAppWeb }
