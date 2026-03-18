#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const CREDENTIALS_ROOT = 'credentials'
const ISSUED_ROOT = path.join('issued', 'users')
const CREDENTIALS_INDEX_PATH = path.join('credentials', 'index.json')
const ISSUED_INDEX_PATH = path.join('issued', 'users', 'index.json')
const PAGES_BASE_URL = process.env.SKILLCRAFT_PAGES_BASE_URL || 'https://skillcraft.gg'

export async function runCredentialsIndexWorkflow() {
  const definitions = await scanCredentialDefinitions()
  const issued = await scanIssuedCredentials()

  await writeJson(CREDENTIALS_INDEX_PATH, definitions)
  await writeJson(ISSUED_INDEX_PATH, issued)
}

if (process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname) {
  await runCredentialsIndexWorkflow()
}

async function scanCredentialDefinitions() {
  const owners = await readDirectoryEntries(CREDENTIALS_ROOT)
  const entries = []

  for (const owner of owners) {
    const ownerDir = path.join(CREDENTIALS_ROOT, owner)
    const slugs = await readDirectoryEntries(ownerDir)

    for (const slug of slugs) {
      const manifestPath = path.join(ownerDir, slug, 'credential.yaml')
      if (!(await fileExists(manifestPath))) {
        continue
      }

      const raw = await fs.readFile(manifestPath, 'utf8')
      const parsed = parseCredentialManifest(raw, manifestPath)

      const id = String(parsed.id || '').trim()
      const expectedId = `${owner}/${slug}`
      if (id !== expectedId) {
        throw new Error(`Credential id mismatch for ${manifestPath}: ${id} !== ${expectedId}`)
      }

      entries.push({
        id,
        name: String(parsed.name || '').trim(),
        description: String(parsed.description || '').trim(),
        requirements: normalizeRequirements(parsed.requirements),
        images: normalizeImageMap(parsed.images),
        owner,
        slug,
        path: path.posix.join(CREDENTIALS_ROOT, owner, slug, ''),
        url: `${PAGES_BASE_URL}/${path.posix.join('credentials', owner, slug, '')}`,
        updatedAt: await fileUpdatedAt(manifestPath),
      })
    }
  }

  return entries.sort((left, right) => left.id.localeCompare(right.id))
}

async function scanIssuedCredentials() {
  const users = await readDirectoryEntries(ISSUED_ROOT)
  const userMap = new Map()

  for (const github of users) {
    const userDir = path.join(ISSUED_ROOT, github)
    const owners = await readDirectoryEntries(userDir)

    for (const owner of owners) {
      const ownerDir = path.join(userDir, owner)
      const slugs = await readDirectoryEntries(ownerDir)

      for (const slug of slugs) {
        const issuedPath = path.join(ownerDir, slug, 'credential.yaml')
        if (!(await fileExists(issuedPath))) {
          continue
        }

        const raw = await fs.readFile(issuedPath, 'utf8')
        const parsed = parseIssuedCredential(raw, issuedPath)
        const definition = String(parsed.definition || '').trim()

        if (!definition) {
          continue
        }

        const entry = {
          definition,
          issuedAt: String(parsed.issued_at || parsed.issuedAt || '').trim(),
          path: path.posix.join('issued', 'users', github, owner, slug, ''),
          claimId: String(parsed.claim_id || '').trim() || undefined,
          sourceCommits: Array.isArray(parsed.source_commits)
            ? normalizeStringList(parsed.source_commits)
            : Array.isArray(parsed.sourceCommits)
              ? normalizeStringList(parsed.sourceCommits)
              : [],
          subject: parsed.subject || { github },
        }

        const userRecord = userMap.get(github) || {
          github,
          issuedCount: 0,
          credentials: [],
        }

        userRecord.credentials.push(entry)
        userRecord.issuedCount += 1
        userMap.set(github, userRecord)
      }
    }
  }

  const normalizedUsers = Array.from(userMap.entries())
    .map(([, userRecord]) => {
      userRecord.credentials.sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))
      return userRecord
    })
    .sort((left, right) => left.github.localeCompare(right.github))

  return normalizedUsers
}

function normalizeRequirements(value) {
  const requirements = isObject(value) ? value : {}

  return {
    minCommits: normalizeNonNegativeInteger(requirements.min_commits, 0),
    mode: requirements.mode === 'or' ? 'or' : 'and',
    skill: normalizeStringList(requirements.skill),
    loadout: normalizeStringList(requirements.loadout),
  }
}

function normalizeImageMap(value) {
  if (!isObject(value)) {
    return {}
  }

  return {
    credential: sanitizeImagePath(value.credential),
    background: sanitizeImagePath(value.background),
  }
}

function sanitizeImagePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

function normalizeStringList(value) {
  if (!value) {
    return []
  }

  if (typeof value === 'string') {
    return [value.trim()].filter(Boolean)
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected string or array, received ${typeof value}`)
  }

  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
}

function normalizeNonNegativeInteger(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback
  }

  return Math.floor(value)
}

function parseCredentialManifest(raw, filePath) {
  const parsed = parseYaml(raw)

  if (!isObject(parsed)) {
    throw new Error(`Credential manifest is not YAML object: ${filePath}`)
  }

  const id = String(parsed.id || '').trim()
  const name = String(parsed.name || '').trim()

  if (!isValidIdentifier(id)) {
    throw new Error(`Invalid credential id at ${filePath}: ${id || '<empty>'}`)
  }

  if (!name) {
    throw new Error(`Credential manifest missing required name at ${filePath}`)
  }

  return parsed
}

function parseIssuedCredential(raw, filePath) {
  const parsed = parseYaml(raw)
  if (!isObject(parsed)) {
    throw new Error(`Issued credential is not YAML object: ${filePath}`)
  }

  return parsed
}

async function readDirectoryEntries(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== '.git' && !name.startsWith('.'))
      .sort()
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function fileUpdatedAt(filePath) {
  try {
    const output = await runGit(['log', '-1', '--format=%cI', '--', filePath])
    return output || new Date().toISOString()
  } catch {
    return new Date().toISOString()
  }
}

async function writeJson(filePath, payload) {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const next = JSON.stringify(payload, null, 2) + '\n'
  await fs.writeFile(filePath, next, 'utf8')
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function parseYaml(input) {
  const lines = input.split(/\r?\n/)
  const root = {}
  const stack = [
    {
      indent: -1,
      container: root,
    },
  ]

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || /^\s*#/.test(line) || /^\s*(---|\.\.\.)\s*$/.test(line)) {
      continue
    }

    const indent = leadingIndent(line)
    const trimmed = line.trim()
    const nextLine = nextMeaningfulLine(lines, index)
    const nextIndent = nextLine ? leadingIndent(nextLine) : -1
    const nextIsList = !!nextLine && nextLine.trim().startsWith('- ')

    while (indent <= stack[stack.length - 1].indent) {
      stack.pop()
    }

    const parent = stack[stack.length - 1].container

    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) {
        continue
      }

      const listItem = parseListItem(trimmed, indent, nextIndent, nextIsList)
      parent.push(listItem.value)

      if (listItem.hasNestedContext) {
        stack.push({ indent, container: listItem.target })
      }

      continue
    }

    const kvMatch = /^([^:#][^:]*)\s*:\s*(.*)$/.exec(trimmed)
    if (!kvMatch) {
      continue
    }

    const key = kvMatch[1].trim()
    const rawValue = kvMatch[2]

    if (rawValue === '') {
      const hasNestedContext = nextLine && nextIndent > indent
      const nextContainer = nextIsList ? [] : {}
      parent[key] = hasNestedContext ? nextContainer : {}

      if (hasNestedContext) {
        stack.push({ indent, container: parent[key] })
      }
      continue
    }

    parent[key] = parseScalar(rawValue)
  }

  return root
}

function parseListItem(trimmed, indent, nextIndent, nextIsList) {
  const itemText = trimmed.slice(2).trim()
  const kvMatch = /^([^:]+):\s*(.*)$/.exec(itemText)
  if (!kvMatch) {
    return {
      value: parseScalar(itemText),
      hasNestedContext: false,
      target: undefined,
    }
  }

  const key = kvMatch[1].trim()
  const rawValue = kvMatch[2]
  const item = {
    [key]: rawValue === '' ? (nextIsList ? [] : {}) : parseScalar(rawValue),
  }

  const hasNestedContext = nextIndent > indent
  const target = hasNestedContext ? (nextIsList ? item[key] : item) : item

  return {
    value: item,
    hasNestedContext,
    target,
  }
}

function leadingIndent(line) {
  const match = /^(\s*)/.exec(line)
  return (match?.[1] || '').length
}

function nextMeaningfulLine(lines, index) {
  for (let offset = 1; index + offset < lines.length; offset += 1) {
    const line = lines[index + offset]
    if (!line.trim() || /^\s*#/.test(line)) {
      continue
    }
    return line
  }
  return undefined
}

function parseScalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }

  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true'
  }

  if (trimmed === 'null' || trimmed === '~') {
    return null
  }

  const numberValue = Number(trimmed)
  if (!Number.isNaN(numberValue) && String(numberValue) === trimmed) {
    return numberValue
  }

  return trimmed
}

function isValidIdentifier(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function runGit(args) {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}
