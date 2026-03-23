import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRequirements } from './build-credentials-index.mjs'

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
