#!/usr/bin/env node
/**
 * Review a Dependabot PR: confirm checks, file scope, and an AI verdict.
 * Prints `decision=APPROVE|BLOCK|SKIP` and `reason=...` for GitHub Actions.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const pr = process.env.PR_NUMBER
const repo = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

if (!pr || !repo || !token) {
  fail('SKIP', 'Missing PR_NUMBER, GITHUB_REPOSITORY, or GITHUB_TOKEN')
}

const allowedPaths = [
  /^software\/package\.json$/,
  /^software\/package-lock\.json$/,
  /^software\/agent\/package\.json$/,
  /^software\/agent\/package-lock\.json$/,
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.github\/dependabot\.yml$/
]

function fail(decision, reason) {
  emit(decision, reason)
  process.exit(decision === 'APPROVE' ? 0 : 0)
}

function emit(decision, reason) {
  const text = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  console.log(`decision=${decision}`)
  console.log(`reason=${text}`)
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `decision=${decision}\nreason=${text}\n`, { flag: 'a' })
  }
}

function ghJson(args) {
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token, GH_REPO: repo }
  })
  return JSON.parse(out)
}

function ghText(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token, GH_REPO: repo }
  })
}

function semverParts(version) {
  const match = String(version).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function bumpKind(from, to) {
  const a = semverParts(from)
  const b = semverParts(to)
  if (!a || !b) return 'unknown'
  if (b.major !== a.major) return 'major'
  if (b.minor !== a.minor) return 'minor'
  return 'patch'
}

const pull = ghJson([
  'pr',
  'view',
  pr,
  '--json',
  'number,title,author,state,mergeable,url,files,statusCheckRollup'
])

const author = pull.author?.login || ''
if (!['dependabot', 'app/dependabot', 'dependabot[bot]'].includes(author)) {
  fail('SKIP', `Not a Dependabot pull request (${author || 'unknown author'})`)
}

if (pull.state !== 'OPEN') {
  fail('SKIP', `Pull request is ${pull.state}`)
}

const checks = pull.statusCheckRollup || []
const blocking = checks.filter((check) => {
  if (check.name === 'Dependabot automation' || check.name === 'Review and merge') return false
  const status = String(check.status || '').toUpperCase()
  const conclusion = String(check.conclusion || '').toUpperCase()
  if (status && status !== 'COMPLETED') return true
  return conclusion !== 'SUCCESS' && conclusion !== 'NEUTRAL' && conclusion !== 'SKIPPED'
})
if (blocking.length > 0) {
  fail(
    'BLOCK',
    `Checks are not all green: ${blocking
      .map((check) => `${check.name}=${check.conclusion || check.status}`)
      .join(', ')}`
  )
}

const typecheck = checks.find((check) => check.name === 'Typecheck')
const typecheckOk = String(typecheck?.conclusion || '').toUpperCase() === 'SUCCESS'
if (!typecheckOk) {
  fail('BLOCK', 'Typecheck did not pass')
}

const paths = (pull.files || []).map((file) => file.path)
const unexpected = paths.filter((path) => !allowedPaths.some((rule) => rule.test(path)))
if (unexpected.length > 0) {
  fail('BLOCK', `Unexpected files in Dependabot PR: ${unexpected.join(', ')}`)
}

const bumpMatch = pull.title.match(/from ([v0-9][^\s]*) to ([v0-9][^\s]*)/i)
const kind = bumpMatch ? bumpKind(bumpMatch[1], bumpMatch[2]) : /group/i.test(pull.title) ? 'group' : 'unknown'
let diff = ''
try {
  diff = ghText(['pr', 'diff', pr])
} catch {
  diff = '(diff unavailable)'
}

const clipped = diff.length > 24000 ? `${diff.slice(0, 24000)}\n\n[diff truncated]` : diff
const prompt = [
  'You review Dependabot updates for Open Weather, a local-first Electron weather app.',
  'Reply with JSON only, no markdown: {"decision":"APPROVE"|"BLOCK","reason":"one sentence"}',
  'APPROVE only routine, low-risk patch or minor bumps, or grouped patch/minor bumps.',
  'BLOCK major bumps of electron, electron-vite, electron-builder, typescript, vite, react, or GitHub Actions.',
  'BLOCK anything that looks like a breaking API change, a new required cloud service, or files outside package manifests.',
  'CI typecheck already passed. Still BLOCK if the bump is too large to trust from typecheck alone.',
  `Title: ${pull.title}`,
  `Inferred bump: ${kind}`,
  `Files: ${paths.join(', ') || '(none)'}`,
  'Diff:',
  clipped
].join('\n\n')

let aiDecision = null
let aiReason = ''

try {
  const response = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You are a cautious dependency reviewer. Output valid JSON only.'
        },
        { role: 'user', content: prompt }
      ]
    })
  })
  if (!response.ok) {
    throw new Error(`GitHub Models HTTP ${response.status}`)
  }
  const payload = await response.json()
  const text = payload.choices?.[0]?.message?.content ?? ''
  const jsonText = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const parsed = JSON.parse(jsonText)
  if (parsed.decision === 'APPROVE' || parsed.decision === 'BLOCK') {
    aiDecision = parsed.decision
    aiReason = parsed.reason || 'AI review completed'
  }
} catch (error) {
  console.error(`AI review fallback: ${error.message}`)
}

if (!aiDecision) {
  if (kind === 'major') {
    fail('BLOCK', 'AI review unavailable; major bump held for a human')
  }
  if (kind === 'unknown') {
    fail('BLOCK', 'AI review unavailable; bump type unclear')
  }
  fail('APPROVE', `AI review unavailable; ${kind} bump passed CI and file-scope checks`)
}

fail(aiDecision, aiReason)
