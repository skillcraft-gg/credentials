import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeRequirements,
  normalizeSourceRepo,
  normalizeSources,
  resolveSourceCommits,
} from './build-credentials-index.mjs'

describe('build-credentials-index requirement normalization', () => {
  test('rejects requirements.mode', () => {
    assert.throws(() => normalizeRequirements({ mode: 'and', skill: 'acme/skill' }), /requirements\.mode is not supported/)
  })

  test('normalizes implicit shorthand requirements to a top-level and tree', () => {
    const requirements = normalizeRequirements({
      min_repositories: 1,
      skill: ['acme/skill-a', 'acme/skill-b'],
      loadout: 'team/dev',
      agent: { provider: 'OpenCode' },
      model: { provider: 'OpenAI', name: 'gpt-4o' },
    })

    assert.equal(requirements.minRepositories, 1)
    assert.equal(requirements.minCommits, 0)
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
        and: [
          { loadout: 'team/dev' },
          { agent: { provider: 'OpenCode' } },
        ],
      },
    })

    assert.equal(requirements.minCommits, 2)
    assert.equal(requirements.minRepositories, 3)
    assert.deepStrictEqual(requirements.tree, {
      and: [
        { loadout: 'team/dev' },
        { agent: { provider: 'OpenCode' } },
      ],
    })
  })

  test('supports nested explicit and/or nodes', () => {
    const requirements = normalizeRequirements({
      and: [
        { skill: 'acme/core' },
        { or: [
          { loadout: 'build' },
          { skill: 'acme/alt' },
        ] },
      ],
    })

    assert.deepStrictEqual(requirements.tree, {
      and: [
        { skill: 'acme/core' },
        { or: [
          { loadout: 'build' },
          { skill: 'acme/alt' },
        ] },
      ],
    })
  })

  test('lowercases provider values for agent and model nodes', () => {
    const requirements = normalizeRequirements({
      and: [
        { agent: { provider: 'OpenAI' } },
        { model: { provider: 'OpenAI', name: 'gpt-4o' } },
      ],
    })

    assert.deepStrictEqual(requirements.tree, {
      and: [
        { agent: { provider: 'openai' } },
        { model: { provider: 'openai', name: 'gpt-4o' } },
      ],
    })
  })
})

describe('build-credentials-index source normalization', () => {
  test('normalizes repository identifiers from common URL formats', () => {
    assert.equal(normalizeSourceRepo('https://github.com/acme/team.git'), 'acme/team')
    assert.equal(normalizeSourceRepo('git@github.com:acme/team.git'), 'acme/team')
    assert.equal(normalizeSourceRepo('acme/team'), 'acme/team')
    assert.equal(normalizeSourceRepo('https://github.com/Acme/TEAM.git/'), 'acme/team')
  })

  test('normalizes source entries and deduplicates per repo', () => {
    const sources = normalizeSources([
      { repo: 'https://github.com/acme/team', commits: ['abc', 'def', 'abc'] },
      { repo: 'git@github.com:acme/team', commits: ['DEF', ''] },
      { repo: 'Acme/Other', commits: ['123'] },
      { repo: 'bad-repo', commits: ['ignored'] },
    ])

    assert.deepStrictEqual(sources, [
      { repo: 'acme/team', commits: ['abc', 'def', 'DEF'] },
      { repo: 'acme/other', commits: ['123'] },
    ])
  })

  test('unifies commit hashes from source arrays and legacy source_commit list', () => {
    const parsed = {
      source_commits: ['aaa', 'bbb', 'AAA'],
      sources: [
        { repo: 'acme/team', commits: ['bbb', 'ccc'] },
      ],
    }

    assert.deepStrictEqual(resolveSourceCommits(parsed), ['aaa', 'bbb', 'AAA', 'ccc'])
  })
})
