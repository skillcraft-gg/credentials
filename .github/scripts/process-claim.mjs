#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const EVENT_PATH = process.env.GITHUB_EVENT_PATH
const DEFAULT_REPO = process.env.GITHUB_REPOSITORY || 'skillcraft-gg/credential-ledger'

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
    if (!payload?.credential?.id) {
      throw new Error('claim payload missing credential.id')
    }
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

    const claimant = normalizeClaimant(payload.claimant.github)
    payload.claimant.github = claimant

    if (await isCredentialAlreadyIssued(claimant, definition)) {
      const issuedPath = getIssuedCredentialPath(claimant, definition)

      await setIssueState(issue.number, targetRepo, {
        add: [LABEL_REJECTED],
        remove: [LABEL_VERIFIED, LABEL_ISSUED],
      })
      await postComment(
        issue.number,
        targetRepo,
        buildAlreadyIssuedComment(payload.credential.id, definition, issuedPath),
      )
      await closeIssue(issue.number, targetRepo, 'not_planned')
      return
    }

    const requirements = normalizeRequirements(definition.requirements)
    const checks = await validateClaimEvidence(payload.sources, payload.claimant.github)

    const result = evaluateRequirements(checks.proofs, checks.provenCommits, checks.provenRepos, requirements)

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
      await closeIssue(issue.number, targetRepo, 'not_planned')
      return
    }

    const issuedPath = await writeIssuedCredential(payload, definition, checks)

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
    await closeIssue(issue.number, targetRepo, 'completed')
  } catch (error) {
    await setIssueState(issue.number, targetRepo, {
      add: [LABEL_REJECTED],
      remove: [LABEL_VERIFIED, LABEL_ISSUED],
    })
    await postComment(issue.number, targetRepo, `Claim verification failed: ${String(error?.message || error)}`)
    await closeIssue(issue.number, targetRepo, 'not_planned')
    throw error
  } finally {
    await setIssueState(issue.number, targetRepo, {
      remove: [LABEL_PROCESSING],
    })
  }
}

function normalizeClaimant(value) {
  return normalizeText(value).toLowerCase()
}

function getIssuedCredentialPath(claimant, definition) {
  const owner = normalizeText(definition?.owner)
  const slug = normalizeText(definition?.slug)
  return path.join('issued', 'users', normalizeText(claimant), owner || 'unknown', slug || 'unknown', 'credential.yaml')
}

async function isCredentialAlreadyIssued(claimant, definition) {
  const normalizedClaimant = normalizeClaimant(claimant)

  const canonicalPath = getIssuedCredentialPath(normalizedClaimant, definition)
  if (await fileExists(canonicalPath)) {
    return true
  }

  const rawPath = path.join('issued', 'users', normalizeText(claimant), normalizeText(definition?.owner), normalizeText(definition?.slug), 'credential.yaml')
  if (rawPath !== canonicalPath && await fileExists(rawPath)) {
    return true
  }

  return isCredentialInIssuedIndex(normalizedClaimant, definition?.id)
}

async function isCredentialInIssuedIndex(claimant, definitionId) {
  const normalizedClaimant = normalizeClaimant(claimant)
  const targetCredential = normalizeText(definitionId)
  if (!normalizedClaimant || !targetCredential) {
    return false
  }

  let raw
  try {
    raw = await fs.readFile(path.join('issued', 'users', 'index.json'), 'utf8')
  } catch {
    return false
  }

  let entries
  try {
    entries = JSON.parse(raw)
  } catch {
    return false
  }

  if (!Array.isArray(entries)) {
    return false
  }

  return entries.some((entry) => {
    const sameUser = normalizeClaimant(entry?.github) === normalizedClaimant
    if (!sameUser || !Array.isArray(entry?.credentials)) {
      return false
    }

    return entry.credentials.some((credential) => normalizeText(credential?.definition) === targetCredential)
  })
}

if (process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname) {
  await runClaimProcessing()
}

export function parseClaimPayload(issue) {
  const parsed = parseYaml(String(issue.body || '').trim())

  if (!isObject(parsed)) {
    throw new Error('claim issue body is not valid YAML')
  }

  const claimant = isObject(parsed.claimant) ? parsed.claimant : undefined
  const credential = parsed.credential
  if (!claimant?.github || typeof claimant.github !== 'string') {
    throw new Error('claim payload missing claimant.github')
  }

  const credentialId = normalizeText(isObject(credential) ? credential.id : normalizeText(credential))
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

export function normalizeRequirements(value) {
  const requirements = isObject(value) ? value : {}

  if (Object.prototype.hasOwnProperty.call(requirements, 'tree')) {
    return normalizeNormalizedRequirements(requirements)
  }

  if (requirements.mode !== undefined) {
    throw new Error('requirements.mode is not supported. Use nested and/or expressions instead.')
  }

  const requirementTree = normalizeRequirementRoot(requirements)

  return {
    minCommits: normalizeNonNegativeInteger(requirements.min_commits, 0),
    minRepositories: normalizeNonNegativeInteger(requirements.min_repositories ?? requirements.minRepositories, 0),
    tree: requirementTree,
  }
}

function normalizeNormalizedRequirements(value) {
  if (!isObject(value.tree)) {
    throw new Error('requirements.tree must be an object when provided')
  }

  const unexpected = Object.keys(value).filter(
    (key) => !['and', 'or', 'min_commits', 'min_repositories', 'minCommits', 'minRepositories', 'tree'].includes(key),
  )
  if (unexpected.length) {
    throw new Error(`Unexpected requirement fields: ${unexpected.join(', ')}`)
  }

  return {
    minCommits: normalizeNonNegativeInteger(value.minCommits, normalizeNonNegativeInteger(value.min_commits, 0)),
    minRepositories: normalizeNonNegativeInteger(value.minRepositories, normalizeNonNegativeInteger(value.min_repositories, 0)),
    tree: value.tree,
  }
}

function normalizeRequirementRoot(value) {
  const hasExplicitAnd = Object.prototype.hasOwnProperty.call(value, 'and')
  const hasExplicitOr = Object.prototype.hasOwnProperty.call(value, 'or')

  if (hasExplicitAnd && hasExplicitOr) {
    throw new Error('requirements cannot include both and and or at the same level')
  }

  if (hasExplicitAnd) {
    const unexpected = Object.keys(value).filter(
      (key) => !['and', 'min_commits', 'min_repositories', 'minRepositories'].includes(key),
    )
    if (unexpected.length) {
      throw new Error(`Unexpected requirement fields: ${unexpected.join(', ')}`)
    }

    return {
      and: normalizeRequirementList(value.and, 'requirements.and'),
    }
  }

  if (hasExplicitOr) {
    const unexpected = Object.keys(value).filter(
      (key) => !['or', 'min_commits', 'min_repositories', 'minRepositories'].includes(key),
    )
    if (unexpected.length) {
      throw new Error(`Unexpected requirement fields: ${unexpected.join(', ')}`)
    }

    return {
      or: normalizeRequirementList(value.or, 'requirements.or'),
    }
  }

  const normalizedShortHand = buildImplicitAndFromShortcuts(value)

  return { and: normalizedShortHand }
}

function normalizeRequirementList(value, location) {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array at ${location}`)
  }

  return value.map((entry, index) => parseRequirementNode(entry, `${location}[${index}]`))
}

function normalizeShortHandList(values, location) {
  if (values === undefined) {
    return []
  }

  if (Array.isArray(values)) {
    return values.map((entry) => {
      const text = parseScalarText(entry)
      if (text === undefined) {
        throw new Error(`Expected text values for ${location}`)
      }
      return text
    })
  }

  const text = parseScalarText(values)
  if (!text) {
    return []
  }

  return [text]
}

function buildImplicitAndFromShortcuts(requirements) {
  const normalized = []
  const known = ['and', 'or', 'min_commits', 'min_repositories', 'minRepositories', 'skill', 'loadout', 'agent', 'model']

  for (const skill of normalizeShortHandList(requirements.skill, 'requirements.skill')) {
    normalized.push({ skill })
  }

  for (const loadout of normalizeShortHandList(requirements.loadout, 'requirements.loadout')) {
    normalized.push({ loadout })
  }

  const hasAgent = Object.prototype.hasOwnProperty.call(requirements, 'agent')
  const agent = normalizeAgentRequirement(requirements.agent)
  if (agent) {
    normalized.push(agent)
  } else if (hasAgent) {
    throw new Error('requirements.agent must be an object with a provider')
  }

  const hasModel = Object.prototype.hasOwnProperty.call(requirements, 'model')
  const model = normalizeModelRequirement(requirements.model)
  if (model) {
    normalized.push(model)
  } else if (hasModel) {
    throw new Error('requirements.model must be an object with optional provider and/or name')
  }

  const nested = Object.keys(requirements).filter((key) => !known.includes(key) && !key.startsWith('$'))
  if (nested.length) {
    throw new Error(`Unexpected requirement fields: ${nested.join(', ')}`)
  }

  return normalized
}

function parseRequirementNode(value, location) {
  if (!isObject(value)) {
    throw new Error(`Invalid requirement node at ${location}`)
  }

  const keys = Object.keys(value)
  if (!keys.length) {
    throw new Error(`Empty requirement node at ${location}`)
  }
  if (keys.length > 1) {
    throw new Error(`Requirement node has multiple keys at ${location}`)
  }

  const [key] = keys

  if (key === 'and' || key === 'or') {
    if (!Array.isArray(value[key])) {
      throw new Error(`Requirement node ${location} expected array for ${key}`)
    }

    return {
      [key]: value[key].map((entry, childIndex) => parseRequirementNode(entry, `${location}.${key}[${childIndex}]`)),
    }
  }

  if (key === 'skill') {
    const text = parseScalarText(value[key])
    if (!text) {
      throw new Error(`Requirement node ${location} has empty skill`) 
    }
    return { skill: text }
  }

  if (key === 'loadout') {
    const text = parseScalarText(value[key])
    if (!text) {
      throw new Error(`Requirement node ${location} has empty loadout`) 
    }
    return { loadout: text }
  }

  if (key === 'agent') {
    const node = normalizeAgentRequirement(value[key])
    if (!node) {
      throw new Error(`Requirement node ${location} has invalid agent requirement`)
    }
    return node
  }

  if (key === 'model') {
    const node = normalizeModelRequirement(value[key])
    if (!node) {
      throw new Error(`Requirement node ${location} has invalid model requirement`)
    }
    return node
  }

  throw new Error(`Unexpected requirement key ${key} at ${location}`)
}

function normalizeAgentRequirement(value) {
  if (!isObject(value)) {
    return undefined
  }

  const provider = parseScalarText(value.provider)
  if (!provider) {
    return undefined
  }

  return {
    agent: {
      provider: provider.toLowerCase(),
    },
  }
}

function normalizeModelRequirement(value) {
  if (!isObject(value)) {
    return undefined
  }

  const provider = parseScalarText(value.provider)
  const name = parseScalarText(value.name)

  if (!provider && !name) {
    return undefined
  }

  return {
    model: {
      ...(provider ? { provider: provider.toLowerCase() } : {}),
      ...(name ? { name } : {}),
    },
  }
}

function parseScalarText(value) {
  return typeof value === 'string' ? value.trim() : undefined
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
  const provenRepos = new Set()
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
        provenRepos.add(normalizeRepoUrl(source.repo))
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
    provenRepos: Array.from(provenRepos).filter(Boolean),
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
    agent: normalizeProofAgent(value.agent),
    model: normalizeProofModel(value.model),
  }
}

function normalizeProofAgent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const provider = normalizeText(value.provider)
  return provider ? { provider: provider.toLowerCase() } : undefined
}

function normalizeProofModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const provider = normalizeText(value.provider)
  const name = normalizeText(value.name)

  if (!provider && !name) {
    return undefined
  }

  return {
    ...(provider ? { provider: provider.toLowerCase() } : {}),
    ...(name ? { name } : {}),
  }
}

export function evaluateRequirements(proofs, provenCommits, provenRepos, requirements) {
  const proofSkills = []
  const proofLoadouts = []
  const proofAgents = []
  const proofModels = []
  const dedupedCommits = Array.from(new Set((provenCommits || []).filter(Boolean)))
  const dedupedRepos = Array.from(new Set((provenRepos || []).filter(Boolean)))

  for (const proof of proofs) {
    for (const skill of proof.proof.skills) {
      const parsed = parseIdentifierWithVersion(skill.id)
      if (parsed.id) {
        proofSkills.push({ id: parsed.id, version: parsed.version })
      }
    }

    for (const loadout of proof.proof.loadouts) {
      const normalized = normalizeText(loadout)
      if (normalized) {
        proofLoadouts.push(normalized)
      }
    }

    if (proof.proof.agent?.provider && typeof proof.proof.agent.provider === 'string') {
      proofAgents.push(proof.proof.agent.provider)
    }

    const modelProvider = proof.proof.model?.provider
    const modelName = proof.proof.model?.name
    if (typeof modelProvider === 'string' || typeof modelName === 'string') {
      proofModels.push({ provider: modelProvider, name: modelName })
    }
  }

  const requirementResult = evaluateRequirementTree(requirements.tree, {
    skills: proofSkills,
    loadouts: proofLoadouts,
    agents: proofAgents,
    models: proofModels,
  })

  const checks = requirementResult.checks
  const resultReasons = [...failedRequirementReasons(checks)]

  if (requirements.minCommits > dedupedCommits.length) {
    resultReasons.push(`minimum required commits not met: have ${dedupedCommits.length}, need ${requirements.minCommits}`)
    requirementResult.passed = false
  }

  if (requirements.minRepositories > dedupedRepos.length) {
    resultReasons.push(`minimum required repositories not met: have ${dedupedRepos.length}, need ${requirements.minRepositories}`)
    requirementResult.passed = false
  }

  return {
    passed: requirementResult.passed,
    proofs,
    provenCommits: dedupedCommits,
    provenRepos: dedupedRepos,
    checks,
    reasons: resultReasons,
    noExplicitChecks: requirementResult.noExplicitChecks,
  }
}

function evaluateRequirementTree(node, context) {
  if (node.and) {
    const checks = []
    const childResults = []
    let noExplicitChecks = true
    for (const child of node.and) {
      const childResult = evaluateRequirementTree(child, context)
      checks.push(...childResult.checks)
      childResults.push(childResult)
      if (!childResult.noExplicitChecks) {
        noExplicitChecks = false
      }
    }

    return {
      passed: childResults.every((entry) => entry.passed),
      checks,
      noExplicitChecks,
    }
  }

  if (node.or) {
    const checks = []
    const childResults = []
    let noExplicitChecks = true
    for (const child of node.or) {
      const childResult = evaluateRequirementTree(child, context)
      checks.push(...childResult.checks)
      childResults.push(childResult)
      if (!childResult.noExplicitChecks) {
        noExplicitChecks = false
      }
    }

    return {
      passed: childResults.some((entry) => entry.passed),
      checks,
      noExplicitChecks,
    }
  }

  if (node.skill) {
    const parsed = parseIdentifierWithVersion(node.skill)
    return {
      passed: proofSkillsMatch(context.skills, parsed),
      checks: [{ type: 'skill', requirement: node.skill, satisfied: proofSkillsMatch(context.skills, parsed) }],
      noExplicitChecks: false,
    }
  }

  if (node.loadout) {
    const parsed = parseTextRequirement(node.loadout)
    return {
      passed: context.loadouts.includes(node.loadout) || (parsed && context.loadouts.includes(parsed.id)),
      checks: [{ type: 'loadout', requirement: node.loadout, satisfied: context.loadouts.includes(node.loadout) || (parsed && context.loadouts.includes(parsed.id)) }],
      noExplicitChecks: false,
    }
  }

  if (node.agent) {
    const expectedProvider = normalizeRequirementText(node.agent.provider)
    return {
      passed: context.agents.some((provider) => provider === expectedProvider),
      checks: [{ type: 'agent', requirement: `provider=${expectedProvider}`, satisfied: context.agents.some((provider) => provider === expectedProvider) }],
      noExplicitChecks: false,
    }
  }

  if (node.model) {
    const expectedProvider = normalizeRequirementText(node.model.provider)
    const expectedName = normalizeRequirementText(node.model.name)
    const isSatisfied = context.models.some((candidate) => {
      const matchProvider = !expectedProvider || candidate.provider === expectedProvider
      const matchName = !expectedName || (candidate.name && candidate.name === expectedName)
      return matchProvider && matchName
    })

    const requirementParts = []
    if (expectedProvider) {
      requirementParts.push(`provider=${expectedProvider}`)
    }
    if (expectedName) {
      requirementParts.push(`name=${expectedName}`)
    }

    return {
      passed: isSatisfied,
      checks: [{ type: 'model', requirement: requirementParts.join(',') || 'model', satisfied: isSatisfied }],
      noExplicitChecks: false,
    }
  }

  throw new Error('Unknown requirement node encountered during evaluation')
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

function parseTextRequirement(value) {
  return parseIdentifierWithVersion(value)
}

function normalizeRequirementText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function proofSkillsMatch(proofSkills, parsed) {
  return proofSkills.some((skill) => matchesId(skill.id, skill.version, parsed))
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
  const outDir = path.join(
    'issued',
    'users',
    normalizeClaimant(payload.claimant.github),
    normalizeText(definition.owner) || 'unknown',
    normalizeText(definition.slug) || 'unknown',
  )
  await fs.mkdir(outDir, { recursive: true })

  const outPath = path.join(outDir, 'credential.yaml')
  const issuedAt = new Date().toISOString()
  const verifiedSources = buildVerifiedSourcesFromProofs(provenCommits)

  const lines = []
  lines.push(`definition: ${definition.id}`)
  lines.push('subject:')
  lines.push(`  github: ${payload.claimant.github}`)
  lines.push(`issued_at: ${issuedAt}`)
  if (payload.claim_id) {
    lines.push(`claim_id: ${payload.claim_id}`)
  }
  if (verifiedSources.length > 0) {
    lines.push('sources:')
    for (const source of verifiedSources) {
      lines.push(`  - repo: ${source.repo}`)
      lines.push('    commits:')
      for (const commit of source.commits) {
        lines.push(`      - ${commit}`)
      }
    }
  }
  lines.push('source_commits:')
  for (const commit of provenCommits?.provenCommits || provenCommits) {
    lines.push(`  - ${commit}`)
  }

  await fs.writeFile(outPath, `${lines.join('\n')}\n`, 'utf8')
  return outPath
}

function buildVerifiedSourcesFromProofs(result) {
  const proofs = Array.isArray(result?.proofs) ? result.proofs : []
  const repositoryMap = new Map()

  for (const proof of proofs) {
    if (!proof || typeof proof !== 'object') {
      continue
    }

    const repo = normalizeRepoUrl(proof.source)
    const commit = normalizeText(proof.commit)
    if (!repo || !commit) {
      continue
    }

    const existing = repositoryMap.get(repo) || []
    existing.push(commit)
    repositoryMap.set(repo, existing)
  }

  return Array.from(repositoryMap.entries())
    .map(([repo, commits]) => ({
      repo: repo.replace(/\.git$/i, ''),
      commits: Array.from(new Set(commits.filter(Boolean).map((entry) => String(entry).trim()))).sort(),
    }))
    .filter((entry) => entry.repo && entry.commits.length > 0)
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

  lines.push(`Required min commits: ${requirements.minCommits}`)
  lines.push(`Required min repositories: ${requirements.minRepositories || 0}`)
  lines.push('')
  lines.push('To retry, fix the claim payload/proof and submit a fresh claim issue.')
  lines.push('Use `skillcraft claim <credential-id>` to submit a new claim.')
  return lines.join('\n')
}

function buildAlreadyIssuedComment(id, definition, issuedPath) {
  const lines = []
  lines.push(`⚠️ Claim for ${id} was already issued.`)
  lines.push('No action was taken.')
  if (issuedPath) {
    lines.push(`Existing credential path: ${issuedPath}`)
  }
  lines.push(`Definition: ${definition?.id || id}`)
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function closeIssue(issueNumber, repo, reason = 'completed') {
  const args = ['issue', 'close', String(issueNumber), '--repo', repo]
  if (reason) {
    args.push('--reason', reason)
  }

  await runGh(args)
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
