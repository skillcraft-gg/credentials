#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const EVENT_PATH = process.env.GITHUB_EVENT_PATH
const DEFAULT_REPO = process.env.GITHUB_REPOSITORY || 'skillcraft-gg/credentials'

const LABEL_CLAIM = 'skillcraft-claim'
const LABEL_PROCESSING = 'skillcraft-processing'
const LABEL_REJECTED = 'skillcraft-rejected'
const LABEL_ISSUED = 'skillcraft-issued'
const LABEL_VERIFIED = 'skillcraft-verified'

const PROOF_BRANCH = 'origin/skillcraft/proofs/v1'

async function runClaimProcessing() {
  const event = await readJsonFromPath(EVENT_PATH)
  const issue = event?.issue
  const targetRepo = event?.repository?.full_name || DEFAULT_REPO

  if (!issue?.number) {
    process.stdout.write('No issue in event payload\n')
    return
  }

  if (!hasLabel(issue.labels, LABEL_CLAIM)) {
    process.stdout.write(`Issue #${issue.number} is not a claim issue\n`)
    return
  }

  let payload
  try {
    payload = parseClaimPayload(issue)
  } catch (error) {
    await setIssueState(issue.number, targetRepo, {
      add: [LABEL_REJECTED],
      remove: [LABEL_PROCESSING],
    })
    await postComment(
      issue.number,
      targetRepo,
      `Claim payload is invalid. ${String(error?.message || error)}\n\nRaw payload:\n\n\`\`\`\n${issue.body || '<empty>'}\n\`\`\``,
    )
    return
  }

  await setIssueState(issue.number, targetRepo, {
    add: [LABEL_PROCESSING],
    remove: [LABEL_REJECTED, LABEL_ISSUED, LABEL_VERIFIED],
  })

  try {
    const definition = await loadCredentialDefinition(payload.credential.id)
    const requirements = normalizeRequirements(definition.requirements)
    const checks = await validateClaimEvidence(payload.sources, payload.claimant.github)

    const result = evaluateRequirements(checks.proofs, checks.provenCommits, requirements)

    if (checks.provenCommits.length < requirements.minCommits) {
      result.reasons.push(`minimum required commits not met: have ${checks.provenCommits.length}, need ${requirements.minCommits}`)
      result.passed = false
    }

    if (!result.passed) {
      await setIssueState(issue.number, targetRepo, {
        add: [LABEL_REJECTED],
        remove: [LABEL_VERIFIED, LABEL_ISSUED],
      })
      await postComment(
        issue.number,
        targetRepo,
        buildRejectionComment(payload.credential.id, requirements, result),
      )
      return
    }

    const issuedPath = await writeIssuedCredential(payload, definition, checks.provenCommits)

    const updated = await buildIndexes()

    await setIssueState(issue.number, targetRepo, {
      add: [LABEL_VERIFIED, LABEL_ISSUED],
      remove: [LABEL_REJECTED],
    })

    await postComment(
      issue.number,
      targetRepo,
      buildSuccessComment(payload, definition, checks.provenCommits, updated, issuedPath),
    )
  } catch (error) {
    await setIssueState(issue.number, targetRepo, {
      add: [LABEL_REJECTED],
      remove: [LABEL_VERIFIED, LABEL_ISSUED],
    })
    await postComment(issue.number, targetRepo, `Claim verification failed: ${String(error?.message || error)}`)
    throw error
  } finally {
    await setIssueState(issue.number, targetRepo, {
      remove: [LABEL_PROCESSING],
    })
  }
}

if (process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname) {
  await runClaimProcessing()
}

async function parseClaimPayload(issue) {
  const parsed = parseYaml(String(issue.body || '').trim())

  if (!isObject(parsed)) {
    throw new Error('claim issue body is not valid YAML')
  }

  const claimant = isObject(parsed.claimant) ? parsed.claimant : undefined
  const credential = isObject(parsed.credential) ? parsed.credential : undefined
  if (!claimant?.github || typeof claimant.github !== 'string') {
    throw new Error('claim payload missing claimant.github')
  }

  const credentialId = normalizeText(credential?.id)
  if (!credentialId) {
    throw new Error('claim payload missing credential.id')
  }

  const sources = normalizeSources(parsed.sources)
  const claimId = normalizeText(parsed.claim_id) || normalizeText(parsed.claimId)

  return {
    claim_version: typeof parsed.claim_version === 'number' ? parsed.claim_version : 1,
    claimant: {
      github: claimant.github,
    },
    credential: {
      id: credentialId,
    },
    claim_id: claimId,
    sources,
  }
}

async function loadCredentialDefinition(id) {
  const [owner, slug] = id.split('/')
  if (!owner || !slug) {
    throw new Error(`Invalid credential id: ${id}`)
  }

  const file = path.join('credentials', owner, slug, 'credential.yaml')
  const raw = await fs.readFile(file, 'utf8')
  const parsed = parseYaml(raw)

  if (!isObject(parsed)) {
    throw new Error(`Credential definition is invalid at ${file}`)
  }

  const manifestId = normalizeText(parsed.id)
  if (manifestId !== id) {
    throw new Error(`Credential id mismatch: expected ${id}, found ${manifestId || '<missing>'} at ${file}`)
  }

  return {
    file,
    id: manifestId,
    name: normalizeText(parsed.name),
    description: normalizeText(parsed.description),
    requirements: normalizeRequirements(parsed.requirements),
    images: normalizeImageMap(parsed.images),
    owner,
    slug,
  }
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

function normalizeSources(value) {
  if (!Array.isArray(value) || !value.length) {
    return []
  }

  return value.map((entry) => {
    if (!isObject(entry)) {
      return null
    }

    const repo = normalizeText(entry.repo)
    const commits = normalizeStringList(entry.commits)

    return { repo, commits }
  }).filter((entry) => entry && entry.repo && entry.commits.length)
}

function normalizeImageMap(value) {
  if (!isObject(value)) {
    return {}
  }

  return {
    credential: normalizeText(value.credential),
    background: normalizeText(value.background),
  }
}

function normalizeStringList(value) {
  if (!value) {
    return []
  }
  if (typeof value === 'string') {
    return [value.trim()].filter(Boolean)
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
}

function normalizeText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

function normalizeNonNegativeInteger(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback
  }

  return Math.floor(value)
}

async function validateClaimEvidence(sources, claimant) {
  if (!sources.length) {
    throw new Error('No valid source commits were supplied')
  }

  const provenCommits = []
  const proofs = []

  for (const source of sources) {
    const repoUrl = normalizeRepoUrl(source.repo)
    if (!repoUrl) {
      throw new Error(`Unsupported repository URL: ${source.repo}`)
    }

    const repoDir = await cloneRepo(repoUrl)

    try {
      for (const commit of source.commits) {
        const normalizedCommit = normalizeText(commit)
        if (!normalizedCommit) {
          continue
        }

        await runGitInDir(repoDir, ['cat-file', '-e', `${normalizedCommit}^{commit}`])

        const proof = await findProofForCommit(repoDir, normalizedCommit)
        if (!proof) {
          throw new Error(`No proof found for commit ${normalizedCommit} in ${source.repo}`)
        }

        provenCommits.push(normalizedCommit)
        proofs.push({
          source: source.repo,
          commit: normalizedCommit,
          proof,
        })
      }
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  }

  return {
    provenCommits: Array.from(new Set(provenCommits)),
    proofs,
    claimant,
  }
}

async function cloneRepo(repoUrl) {
  const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillcraft-claim-'))
  await runGit(['clone', '--quiet', '--no-checkout', repoUrl, cloneDir])
  return cloneDir
}

async function findProofForCommit(repoDir, commit) {
  const proofFiles = await listProofFiles(repoDir)
  if (!proofFiles.length) {
    return undefined
  }

  for (const file of proofFiles) {
    const raw = await runGitInDir(repoDir, ['show', `${PROOF_BRANCH}:${file}`])
    let parsed

    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }

    const proof = normalizeProof(parsed)
    if (proof && proof.commit === commit) {
      return proof
    }
  }

  return undefined
}

async function listProofFiles(repoDir) {
  try {
    const output = await runGitInDir(repoDir, ['ls-tree', '-r', '--name-only', PROOF_BRANCH, 'proofs'])
    return output.split('\n').map((file) => file.trim()).filter((file) => file.endsWith('.json'))
  } catch {
    return []
  }
}

function normalizeProof(value) {
  if (!isObject(value)) {
    return undefined
  }

  if (typeof value.version !== 'number' || typeof value.commit !== 'string' || !Array.isArray(value.skills) || !Array.isArray(value.loadouts)) {
    return undefined
  }

  if (typeof value.timestamp !== 'string' || !value.timestamp) {
    return undefined
  }

  const skills = value.skills
    .map((entry) => {
      if (typeof entry === 'string') {
        return {
          id: entry,
        }
      }

      if (isObject(entry) && typeof entry.id === 'string') {
        return {
          id: entry.id,
          version: normalizeText(entry.version),
        }
      }

      return undefined
    })
    .filter((entry) => entry && entry.id)

  return {
    version: value.version,
    commit: value.commit,
    skills,
    loadouts: value.loadouts
      .map((entry) => normalizeText(entry))
      .filter(Boolean),
    timestamp: value.timestamp,
  }
}

function evaluateRequirements(proofs, provenCommits, requirements) {
  const proofSkills = []
  const proofLoadouts = []

  for (const proof of proofs) {
    for (const skill of proof.proof.skills) {
      const normalized = parseIdentifierWithVersion(skill.id)
      if (normalized.id) {
        proofSkills.push({ id: normalized.id, version: normalized.version })
      }
    }

    for (const loadout of proof.proof.loadouts) {
      const normalized = normalizeText(loadout)
      if (normalized) {
        proofLoadouts.push(normalized)
      }
    }
  }

  const requirementsChecks = []
  for (const requirement of requirements.skill) {
    const parsed = parseIdentifierWithVersion(requirement)
    requirementsChecks.push({
      type: 'skill',
      requirement,
      satisfied: proofSkills.some((skill) => matchesId(skill.id, skill.version, parsed)),
    })
  }

  for (const requirement of requirements.loadout) {
    const parsed = parseIdentifierWithVersion(requirement)
    requirementsChecks.push({
      type: 'loadout',
      requirement,
      satisfied: proofLoadouts.includes(requirement) || proofLoadouts.includes(parsed.id),
    })
  }

  const checks = requirementsChecks.filter(Boolean)
  const noExplicitChecks = checks.length === 0
  let passed
  if (noExplicitChecks) {
    passed = true
  } else if (requirements.mode === 'or') {
    passed = checks.some((entry) => entry.satisfied)
  } else {
    passed = checks.every((entry) => entry.satisfied)
  }

  return {
    passed,
    proofs,
    provenCommits,
    checks,
    reasons: !passed ? failedRequirementReasons(checks) : [],
    noExplicitChecks,
  }
}

function matchesId(actualId, actualVersion, expected) {
  if (actualId !== expected.id) {
    return false
  }

  if (!expected.version) {
    return true
  }

  return actualVersion === expected.version
}

function failedRequirementReasons(checks) {
  return checks.filter((entry) => !entry.satisfied).map((entry) => `${entry.type} ${entry.requirement} not met`)
}

function parseIdentifierWithVersion(value) {
  const trimmed = normalizeText(value)
  if (!trimmed) {
    return { id: '', version: '' }
  }
  const parts = trimmed.split('@')
  return {
    id: parts[0],
    version: parts.length > 1 ? parts.slice(1).join('@') : undefined,
  }
}

async function writeIssuedCredential(payload, definition, provenCommits) {
  const outDir = path.join('issued', 'users', payload.claimant.github, definition.owner, definition.slug)
  await fs.mkdir(outDir, { recursive: true })

  const outPath = path.join(outDir, 'credential.yaml')
  const issuedAt = new Date().toISOString()

  const lines = []
  lines.push(`definition: ${definition.id}`)
  lines.push('subject:')
  lines.push(`  github: ${payload.claimant.github}`)
  lines.push(`issued_at: ${issuedAt}`)
  if (payload.claim_id) {
    lines.push(`claim_id: ${payload.claim_id}`)
  }
  lines.push('source_commits:')
  for (const commit of provenCommits) {
    lines.push(`  - ${commit}`)
  }

  await fs.writeFile(outPath, `${lines.join('\n')}\n`, 'utf8')
  return outPath
}

async function buildIndexes() {
  const result = await runNodeScript('./.github/scripts/build-credentials-index.mjs')
  return !!result
}

function buildSuccessComment(payload, definition, provenCommits, updatedIndexes, issuedPath) {
  const lines = []
  lines.push('✅ Claim verified for `' + payload.credential.id + '`')
  if (definition.name) {
    lines.push(`Credential: ${definition.name}`)
  }
  lines.push(`Issued file: ${issuedPath}`)
  lines.push(`Proof-backed commits: ${provenCommits.length}`)
  lines.push(`Issued at: ${new Date().toISOString()}`)
  lines.push(updatedIndexes ? 'Indexes updated: yes' : 'Indexes updated: no')
  return lines.join('\n')
}

function buildRejectionComment(id, requirements, result) {
  const lines = []
  lines.push('❌ Claim for `' + id + '` was not issued.')
  lines.push('')
  if (result.reasons.length) {
    lines.push('Unmet checks:')
    for (const reason of result.reasons) {
      lines.push(`- ${reason}`)
    }
    lines.push('')
  }

  lines.push('Requirement mode: `' + requirements.mode + '`')
  lines.push(`Required min commits: ${requirements.minCommits}`)
  return lines.join('\n')
}

function hasLabel(labels, name) {
  return (labels || []).some((label) => {
    const labelName = typeof label === 'string' ? label : label?.name
    return labelName === name
  })
}

async function setIssueState(issueNumber, repo, { add = [], remove = [] } = {}) {
  if (!add.length && !remove.length) {
    return
  }

  const args = ['issue', 'edit', String(issueNumber), '--repo', repo]
  if (add.length) {
    args.push('--add-label', add.join(','))
  }
  if (remove.length) {
    args.push('--remove-label', remove.join(','))
  }

  await runGh(args)
}

async function postComment(issueNumber, repo, body) {
  const cleaned = String(body || '').slice(0, 65000)
  await runGh(['issue', 'comment', String(issueNumber), '--repo', repo, '--body', cleaned])
}

async function runNodeScript(relativePath) {
  const script = path.resolve(relativePath)
  const result = await execFileAsync(process.execPath, [script], {
    env: { ...process.env },
    encoding: 'utf8',
  })
  return result.stdout.trim()
}

async function runGh(args) {
  if (!await hasGh()) {
    throw new Error('gh CLI is required for claim processing')
  }

  await execFileAsync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_PAGER: '' },
    maxBuffer: 10 * 1024 * 1024,
  })
}

async function hasGh() {
  try {
    await execFileAsync('gh', ['--version'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
    return true
  } catch {
    return false
  }
}

async function runGit(args) {
  await execFileAsync('git', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
}

async function runGitInDir(dir, args) {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

function normalizeRepoUrl(value) {
  const text = normalizeText(value)
  if (!text) {
    return ''
  }

  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/.+?)(?:\.git)?$/i.exec(text)
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}.git`
  }

  const sshMatch = /^git@github\.com:([^/]+\/.+?)(?:\.git)?$/i.exec(text)
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}.git`
  }

  return ''
}

function parseYaml(input) {
  const lines = String(input || '').split(/\r?\n/)
  const root = {}
  const stack = [
    {
      indent: -1,
      container: root,
    },
  ]

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    if (!rawLine || !rawLine.trim() || /^\s*#/.test(rawLine) || /^\s*(---|\.\.\.)\s*$/.test(rawLine)) {
      continue
    }

    const indent = leadingIndent(rawLine)
    const trimmed = rawLine.trim()
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

      const listValue = parseListItem(trimmed, indent, nextIndent, nextIsList)
      parent.push(listValue.value)

      if (listValue.hasNestedContext) {
        stack.push({ indent, container: listValue.target })
      }
      continue
    }

    const kvMatch = /^([^:#\s][^:]*)\s*:\s*(.*)$/.exec(trimmed)
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

  return { value: item, hasNestedContext, target }
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

function leadingIndent(line) {
  const match = /^\s*/.exec(line)
  return (match?.[0] || '').length
}

function parseScalar(value) {
  const trimmed = String(value).trim()

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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJsonFromPath(filePath) {
  if (!filePath) {
    return undefined
  }

  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}
