#!/usr/bin/env node
/**
 * Triage a finished CI run: comment on the PR or open/close a sticky branch issue.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MARKER = '<!-- ci-triage -->'
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const repo = process.env.GITHUB_REPOSITORY
const runId = process.env.RUN_ID
const conclusion = String(process.env.RUN_CONCLUSION || '').toLowerCase()
const eventName = process.env.RUN_EVENT || ''
const headBranch = process.env.RUN_HEAD_BRANCH || ''
const headSha = process.env.RUN_HEAD_SHA || ''
const htmlUrl = process.env.RUN_HTML_URL || ''

if (!token || !repo || !runId) {
  console.error('Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or RUN_ID')
  process.exit(1)
}

const ghEnv = { ...process.env, GH_TOKEN: token, GH_REPO: repo }

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', env: ghEnv, maxBuffer: 20 * 1024 * 1024 })
  return JSON.parse(out)
}

function ghText(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', env: ghEnv, maxBuffer: 20 * 1024 * 1024 })
  } catch (error) {
    if (allowFail) return `${error.stdout || ''}${error.stderr || ''}`
    throw error
  }
}

function ghInput(method, path, payload) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-triage-'))
  const file = join(dir, 'body.json')
  writeFileSync(file, JSON.stringify(payload))
  const out = execFileSync('gh', ['api', '--method', method, path, '--input', file], {
    encoding: 'utf8',
    env: ghEnv,
    maxBuffer: 20 * 1024 * 1024
  })
  return out.trim() ? JSON.parse(out) : null
}

function isStaleFailure() {
  if (!headBranch) return false
  try {
    const runs = ghJson([
      'run',
      'list',
      '--workflow',
      'ci.yml',
      '--branch',
      headBranch,
      '--limit',
      '8',
      '--json',
      'databaseId,conclusion,status,createdAt'
    ])
    return (runs || []).some(
      (run) => Number(run.databaseId) > Number(runId) && String(run.conclusion) === 'success'
    )
  } catch (error) {
    console.error(`Stale-run check failed: ${error.message}`)
    return false
  }
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
}

function clip(text, max = 4000) {
  const clean = stripAnsi(text).replace(/\r/g, '').trim()
  if (clean.length <= max) return clean
  return `…[truncated]\n${clean.slice(-max)}`
}

function shortSha(sha) {
  return String(sha || '').slice(0, 7)
}

function stickyTitle(branch) {
  return `CI is failing on ${branch}`
}

function ensureLabel(name, color, description) {
  try {
    ghText([
      'label',
      'create',
      name,
      '--color',
      color,
      '--description',
      description,
      '--force'
    ])
  } catch (error) {
    console.error(`Could not ensure label ${name}: ${error.message}`)
  }
}

function findPrNumber() {
  try {
    const pulls = ghJson(['api', `repos/${repo}/commits/${headSha}/pulls`])
    const open = (pulls || []).find((pull) => pull.state === 'open')
    if (open) return open.number
    if (pulls?.[0]?.number) return pulls[0].number
  } catch (error) {
    console.error(`Commit pull lookup failed: ${error.message}`)
  }
  return null
}

function failedJobs(jobs) {
  return (jobs || []).filter((job) => {
    const status = String(job.conclusion || '').toLowerCase()
    return status === 'failure' || status === 'timed_out' || status === 'startup_failure'
  })
}

function heuristicTriage(jobs, log) {
  const names = jobs.map((job) => job.name).join(' | ')
  const haystack = `${names}\n${log}`.toLowerCase()
  const os =
    /macos/.test(haystack) && /windows/.test(haystack)
      ? 'multiple'
      : /macos/.test(haystack)
        ? 'macos'
        : /windows/.test(haystack)
          ? 'windows'
          : /ubuntu|linux/.test(haystack)
            ? 'linux'
            : 'n/a'

  let area = 'unknown'
  let summary = `CI failed${names ? `: ${names}` : ''}.`
  const nextSteps = ['Open the failed run and read the job that went red first.']

  if (/error ts\d+|typecheck/.test(haystack) && /typecheck/.test(names.toLowerCase())) {
    area = 'typecheck'
    summary = 'Typecheck failed — TypeScript rejected the tree before packaging.'
    nextSteps.push('Run `npm run typecheck` in `software/` and fix the reported files.')
  } else if (/eresolve|npm err!|npm ci/.test(haystack)) {
    area = 'dependencies'
    summary = 'Dependency install failed (`npm ci` or a peer-dependency conflict).'
    nextSteps.push('Check `software/package-lock.json` and any peer-dependency errors in the log.')
  } else if (/electron-builder|cannot find module|error ts\d+/.test(haystack) && /build/.test(haystack)) {
    area = 'packaging'
    summary = 'Packaging failed while building the installer or disk image.'
    nextSteps.push('Inspect the electron-builder output in the failed OS job.')
  } else if (/codesign|xattr|hdiutil|gatekeeper|ad-hoc/.test(haystack) || /macos/.test(names.toLowerCase())) {
    area = 'macos-install'
    summary = 'macOS package, copy, ad-hoc sign, or launch failed (no Apple Developer certificate on CI).'
    nextSteps.push('Check the DMG attach / `codesign --sign -` / `--smoke-test` steps on the macOS job.')
  } else if (/setup\.exe|nsis|ow-ci|smoke test exited/.test(haystack) || /windows/.test(names.toLowerCase())) {
    area = 'windows-install'
    summary = 'Windows installer or smoke launch failed.'
    nextSteps.push('Confirm the NSIS `/S` install wrote the exe and that `--smoke-test` exited 0.')
  } else if (/dpkg|\.deb|xvfb|dbus-run-session/.test(haystack) || /ubuntu/.test(names.toLowerCase())) {
    area = 'linux-install'
    summary = 'Linux `.deb` install or headed smoke test under Xvfb failed.'
    nextSteps.push('Check `apt-get install` for the `.deb`, then the Xvfb `--smoke-test` log.')
  } else if (/smoke-test|renderer process gone|did-fail-load/.test(haystack)) {
    area = 'smoke-test'
    summary = 'The installed app started but the smoke test did not see a loaded window.'
    nextSteps.push('Look for `[smoke-test]` lines and renderer/GPU crashes in that OS job.')
  } else if (/no space left|resource exhausted|the runner|received shutdown signal/.test(haystack)) {
    area = 'infra'
    summary = 'The failure looks like GitHub runner or resource trouble, not app code.'
    nextSteps.push('Re-run the failed jobs. If it repeats, check Actions status and runner disk.')
  }

  const flake = area === 'infra' || /unexpected eof|connection reset|econnreset/.test(haystack)
  return {
    summary,
    area,
    os,
    likely_cause: summary,
    next_steps: nextSteps.slice(0, 4),
    flake
  }
}

async function aiTriage(jobs, log, heuristic) {
  const prompt = [
    'You triage CI failures for Open Weather, a local-first Electron weather app.',
    'Reply with JSON only, no markdown:',
    '{"summary":"one sentence","area":"typecheck|packaging|windows-install|macos-install|linux-install|smoke-test|dependencies|infra|unknown","os":"linux|windows|macos|multiple|n/a","likely_cause":"2-4 sentences","next_steps":["step","step"],"flake":false}',
    'Be concrete. Prefer a code/config cause over blaming the runner unless the log shows infra errors.',
    'macOS CI has no Apple Developer certificate; it ad-hoc signs after copying from the DMG.',
    `Failed jobs: ${jobs.map((job) => job.name).join(', ') || '(unknown)'}`,
    `Branch: ${headBranch}  SHA: ${headSha}`,
    'Heuristic guess:',
    JSON.stringify(heuristic),
    'Failed log excerpt:',
    clip(log, 12000)
  ].join('\n\n')

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
            content: 'You are a CI triage assistant. Output valid JSON only.'
          },
          { role: 'user', content: prompt }
        ]
      })
    })
    if (!response.ok) throw new Error(`GitHub Models HTTP ${response.status}`)
    const payload = await response.json()
    const text = payload.choices?.[0]?.message?.content ?? ''
    const jsonText = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(jsonText)
    if (!parsed.summary) throw new Error('AI JSON missing summary')
    return {
      summary: String(parsed.summary),
      area: parsed.area || heuristic.area,
      os: parsed.os || heuristic.os,
      likely_cause: parsed.likely_cause || parsed.summary,
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.slice(0, 5) : heuristic.next_steps,
      flake: Boolean(parsed.flake)
    }
  } catch (error) {
    console.error(`AI triage fallback: ${error.message}`)
    return heuristic
  }
}

function renderFailureBody({ triage, jobs, log, pr }) {
  const jobList = jobs.length
    ? jobs.map((job) => `- ${job.name} (${job.conclusion})`).join('\n')
    : '- (could not list failed jobs)'
  const steps = (triage.next_steps || []).map((step) => `- ${step}`).join('\n')
  const flake = triage.flake ? '\n\nThis may be flaky infrastructure. A re-run is a reasonable first try.' : ''
  const excerpt = clip(log, 3500) || '(no failed log captured)'
  const audience = pr
    ? 'Posted on the pull request so the author can fix the run without opening a separate issue.'
    : `Sticky issue for \`${headBranch}\`. It will close automatically when CI on this branch is green again.`

  return `${MARKER}
## CI triage

${audience}

**Run:** [${shortSha(headSha) || runId}](${htmlUrl}) on \`${headBranch || 'unknown'}\`  
**Area:** ${triage.area} · **OS:** ${triage.os} · **Conclusion:** ${conclusion}

### Likely cause

${triage.likely_cause}${flake}

### Failed jobs

${jobList}

### What to try first

${steps}

<details>
<summary>Failed log excerpt</summary>

\`\`\`
${excerpt.replace(/```/g, "'''")}
\`\`\`

</details>
`
}

function upsertPrComment(pr, body) {
  const comments = ghJson(['api', `repos/${repo}/issues/${pr}/comments?per_page=100`])
  const existing = (comments || []).find((comment) => String(comment.body || '').includes(MARKER))
  if (existing) {
    ghInput('PATCH', `repos/${repo}/issues/comments/${existing.id}`, { body })
    console.log(`Updated triage comment on PR #${pr}`)
    return
  }
  ghInput('POST', `repos/${repo}/issues/${pr}/comments`, { body })
  console.log(`Posted triage comment on PR #${pr}`)
}

function deletePrComment(pr) {
  const comments = ghJson(['api', `repos/${repo}/issues/${pr}/comments?per_page=100`])
  const existing = (comments || []).find((comment) => String(comment.body || '').includes(MARKER))
  if (!existing) return
  ghText(['api', '--method', 'DELETE', `repos/${repo}/issues/comments/${existing.id}`], { allowFail: true })
  console.log(`Removed stale triage comment on PR #${pr}`)
}

function findStickyIssue(branch) {
  const title = stickyTitle(branch)
  try {
    const issues = ghJson([
      'issue',
      'list',
      '--label',
      'ci',
      '--state',
      'open',
      '--json',
      'number,title,body'
    ])
    return (issues || []).find((issue) => issue.title === title) || null
  } catch (error) {
    console.error(`Sticky issue lookup failed: ${error.message}`)
    return null
  }
}

function upsertStickyIssue(branch, body, summary) {
  ensureLabel('ci', '5319E7', 'CI, Actions, or release automation')
  ensureLabel('bug', 'D73A4A', 'Something is broken')
  ensureLabel('needs-triage', 'FBCA04', 'Needs a human look')
  const existing = findStickyIssue(branch)
  if (existing) {
    ghInput('POST', `repos/${repo}/issues/${existing.number}/comments`, { body })
    console.log(`Commented on sticky issue #${existing.number}`)
    return existing.number
  }
  const created = ghInput('POST', `repos/${repo}/issues`, {
    title: stickyTitle(branch),
    body,
    labels: ['ci', 'bug', 'needs-triage']
  })
  console.log(`Opened sticky issue #${created.number}: ${summary}`)
  return created.number
}

function closeStickyIssue(branch) {
  const existing = findStickyIssue(branch)
  if (!existing) return
  ghInput('POST', `repos/${repo}/issues/${existing.number}/comments`, {
    body: `${MARKER}\nCI is green again on \`${branch}\` ([run](${htmlUrl}), \`${shortSha(headSha)}\`).`
  })
  ghText(['issue', 'close', String(existing.number)])
  console.log(`Closed sticky issue #${existing.number}`)
}

const isPrEvent = eventName === 'pull_request'
const pr = isPrEvent ? findPrNumber() : null
const isFailure = ['failure', 'timed_out', 'startup_failure'].includes(conclusion)

if (!isFailure) {
  if (pr) deletePrComment(pr)
  else if (headBranch) closeStickyIssue(headBranch)
  process.exit(0)
}

if (isStaleFailure()) {
  console.log(`Skipping stale failure ${runId}; a newer CI run on ${headBranch} already succeeded.`)
  if (pr) deletePrComment(pr)
  else if (headBranch) closeStickyIssue(headBranch)
  process.exit(0)
}

const jobsPayload = ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=50`])
const jobs = failedJobs(jobsPayload.jobs || jobsPayload)
const log = ghText(['run', 'view', String(runId), '--log-failed', '--repo', repo], { allowFail: true })
const heuristic = heuristicTriage(jobs, log)
const triage = await aiTriage(jobs, log, heuristic)
const body = renderFailureBody({ triage, jobs, log, pr: Boolean(pr) })

if (pr) {
  upsertPrComment(pr, body)
} else if (headBranch) {
  upsertStickyIssue(headBranch, body, triage.summary)
} else {
  console.error('CI failed but no pull request or branch was found; wrote triage to log only.')
  console.log(body)
}
