import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRequirements, normalizeRequirements, parseClaimPayload } from './process-claim.mjs'

function proof(overrides = {}) {
  return {
    proof: {
      version: 1,
      commit: 'commit-id',
      skills: [],
      loadouts: [],
      timestamp: '2026-01-01T00:00:00Z',
      ...overrides,
    },
  }
}

describe('process-claim requirement parsing and enforcement', () => {
  test('rejects requirements.mode', () => {
    assert.throws(() => normalizeRequirements({ mode: 'and', skill: 'acme/skill' }), /requirements\.mode is not supported/)
  })

  test('supports top-level shorthand for implicit and', () => {
    const requirements = normalizeRequirements({
      min_commits: 1,
      min_repositories: 2,
      skill: ['acme/skill-a', 'acme/skill-b'],
      loadout: 'team/dev',
      agent: { provider: 'OpenCode' },
      model: { provider: 'OpenAI', name: 'gpt-4o' },
    })

    assert.equal(requirements.minCommits, 1)
    assert.equal(requirements.minRepositories, 2)
    assert.deepStrictEqual(requirements.tree, {
      and: [
        { skill: 'acme/skill-a' },
        { skill: 'acme/skill-b' },
        { loadout: 'team/dev' },
        { agent: { provider: 'opencode' } },
        { model: { provider: 'openai', name: 'gpt-4o' } },
      ],
    })
  })

  test('supports already-normalized canonical requirements', () => {
    const requirements = normalizeRequirements({
      minCommits: 2,
      minRepositories: 3,
      tree: {
        or: [
          { skill: 'acme/skill-a' },
          { model: { provider: 'OpenAI', name: 'gpt-4o' } },
        ],
      },
    })

    assert.equal(requirements.minCommits, 2)
    assert.equal(requirements.minRepositories, 3)
    assert.deepStrictEqual(requirements.tree, {
      or: [
        { skill: 'acme/skill-a' },
        { model: { provider: 'OpenAI', name: 'gpt-4o' } },
      ],
    })
  })

  test('evaluates nested and/or requirements', () => {
    const requirements = normalizeRequirements({
      min_commits: 2,
      and: [
        { skill: 'acme/core' },
        {
          or: [
            { loadout: 'build' },
            { skill: 'acme/backup' },
          ],
        },
      ],
    })

    const successProofs = [
      proof({
        skills: [{ id: 'acme/core' }],
        loadouts: ['build'],
      }),
    ]
    const failureProofs = [
      proof({
        skills: [{ id: 'acme/core' }],
        loadouts: ['docs'],
      }),
    ]

    const success = evaluateRequirements(successProofs, ['c1', 'c2'], ['https://github.com/acme/repo.git'], requirements)
    const failure = evaluateRequirements(failureProofs, ['c1', 'c2'], ['https://github.com/acme/repo.git'], requirements)

    assert.equal(success.passed, true)
    assert.equal(failure.passed, false)
    assert.ok(failure.checks.some((entry) => entry.type === 'loadout' && entry.satisfied === false))
  })

  test('enforces agent and model requirements', () => {
    const requirements = normalizeRequirements({
      and: [
        { agent: { provider: 'opencode' } },
        { model: { provider: 'openai', name: 'gpt-4o' } },
      ],
    })

    const validProofs = [
      proof({
        agent: { provider: 'opencode' },
        model: { provider: 'openai', name: 'gpt-4o' },
      }),
    ]

    const wrongAgent = [
      proof({
        agent: { provider: 'claude' },
        model: { provider: 'openai', name: 'gpt-4o' },
      }),
    ]

    const wrongModelName = [
      proof({
        agent: { provider: 'opencode' },
        model: { provider: 'openai', name: 'gpt-4' },
      }),
    ]

    const pass = evaluateRequirements(validProofs, ['commit'], ['https://github.com/acme/repo.git'], requirements)
    const failAgent = evaluateRequirements(wrongAgent, ['commit'], ['https://github.com/acme/repo.git'], requirements)
    const failModel = evaluateRequirements(wrongModelName, ['commit'], ['https://github.com/acme/repo.git'], requirements)

    assert.equal(pass.passed, true)
    assert.equal(failAgent.passed, false)
    assert.equal(failModel.passed, false)
  })

  test('enforces min_repositories from unique repo count', () => {
    const requirements = normalizeRequirements({
      min_repositories: 2,
      min_commits: 1,
    })

    const proofs = [proof()]

    const oneRepo = evaluateRequirements(proofs, ['c1'], ['https://github.com/acme/repo.git', 'https://github.com/acme/repo.git'], requirements)
    const twoRepos = evaluateRequirements(
      proofs,
      ['c1'],
      ['https://github.com/acme/repo.git', 'https://github.com/acme/repo.git', 'https://github.com/acme/other.git'],
      requirements,
    )

    assert.equal(oneRepo.passed, false)
    assert.ok(oneRepo.reasons.includes('minimum required repositories not met: have 1, need 2'))
    assert.equal(twoRepos.passed, true)
  })
})

describe('process-claim payload parsing', () => {
  test('parses required claimant and credential id from issue body', () => {
    const payload = parseClaimPayload({
      body: `claim_version: 2\nclaimant:\n  github: blairhudson\ncredential:\n  id: skillcraft-gg/hello-world\nsources:\n  - repo: https://github.com/blairhudson/project-a\n    commits:\n      - abc123\nclaim_id: sha256:12345`,
    })

    assert.equal(payload.claimant.github, 'blairhudson')
    assert.equal(payload.credential.id, 'skillcraft-gg/hello-world')
    assert.equal(payload.claim_version, 2)
    assert.equal(payload.claim_id, 'sha256:12345')
    assert.equal(payload.sources.length, 1)
    assert.equal(payload.sources[0].repo, 'https://github.com/blairhudson/project-a')
    assert.deepStrictEqual(payload.sources[0].commits, ['abc123'])
  })

  test('accepts legacy credential string shorthand', () => {
    const payload = parseClaimPayload({
      body: `claimant:\n  github: blairhudson\ncredential: skillcraft-gg/hello-world`,
    })

    assert.equal(payload.credential.id, 'skillcraft-gg/hello-world')
    assert.equal(payload.claim_version, 1)
  })

  test('rejects payload without credential id', () => {
    assert.throws(
      () => parseClaimPayload({
        body: 'claimant:\n  github: blairhudson\n',
      }),
      /claim payload missing credential.id/,
    )
  })
})
