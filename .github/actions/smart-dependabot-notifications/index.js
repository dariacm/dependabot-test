import * as core from '@actions/core'
import * as github from '@actions/github'

async function run() {
  try {
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN
    const reviewersInput = core.getInput('reviewers') || ''
    const teamReviewersInput = core.getInput('team-reviewers') || ''
    const customComment = core.getInput('comment')

    if (!token) {
      core.setFailed('GitHub token is required. Provide github-token input or ensure GITHUB_TOKEN is available.')
      return
    }

    const octokit = github.getOctokit(token)
    const context = github.context

    if (context.eventName !== 'workflow_run') {
      core.setFailed(`This action can only be run on workflow_run events. Current event: ${context.eventName}`)
      return
    }

    const workflowRunId = context.payload.workflow_run?.id
    if (!workflowRunId) {
      core.setFailed('No workflow_run ID found in context')
      return
    }

    const { data: run } = await octokit.rest.actions.getWorkflowRun({
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: workflowRunId
    })

    if (run.actor?.login !== 'dependabot[bot]') {
      core.info(`Skipping: Actor is ${run.actor?.login}, not dependabot[bot]`)
      return
    }

    if (run.conclusion !== 'failure') {
      core.info(`Skipping: Workflow run conclusion is ${run.conclusion}, not failure`)
      return
    }

    if (!run.pull_requests || run.pull_requests.length === 0) {
      core.info('No pull request associated with this workflow run. Skipping.')
      return
    }

    const pullNumber = run.pull_requests[0].number
    core.info(`Processing PR #${pullNumber}`)

    const { data: pr } = await octokit.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullNumber
    })

    if (pr.requested_reviewers.length > 0 || pr.requested_teams.length > 0) {
      core.info('Reviews already requested for this PR. Skipping.')
      return
    }

    const reviewers = reviewersInput.split(',').map(r => r.trim()).filter(r => r)
    const teamReviewers = teamReviewersInput.split(',').map(t => t.trim()).filter(t => t)

    if (reviewers.length === 0 && teamReviewers.length === 0) {
      core.info('No reviewers or team reviewers specified. Skipping.')
      return
    }

    const requestPayload = {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullNumber
    }

    if (teamReviewers.length > 0) {
      requestPayload.team_reviewers = teamReviewers
      core.info(`Requesting reviews from teams: ${teamReviewers.join(', ')}`)
    }

    if (reviewers.length > 0) {
      requestPayload.reviewers = reviewers
      core.info(`Requesting reviews from users: ${reviewers.join(', ')}`)
    }

    await octokit.rest.pulls.requestReviewers(requestPayload)
    core.info('Successfully requested reviewers')

    const comment = customComment || 'dependabot was not able to automerge this pull request. Humans, please help 🤖'

    const { data: comments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pullNumber
    })

    const commentExists = comments.some(c => c.body === comment)

    if (!commentExists) {
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullNumber,
        body: comment
      })
      core.info('Successfully posted comment')
    } else {
      core.info('Comment already posted for this PR. Skipping.')
    }

    core.setOutput('pull-request-number', pullNumber)
    core.setOutput('reviewers-added', reviewers.length + teamReviewers.length)
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
