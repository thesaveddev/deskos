import { useEffect, useMemo, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { getOverviewReport, type OverviewReport } from '../lib/reports.js'
import { createPlaybook } from '../lib/ai-worker.js'
import { useAuth } from '../lib/auth.js'

type Candidate = {
  key: string
  label: string
  kind: 'Category' | 'Type' | 'Team'
  volume: number
}

const DEFAULT_AUTOMATION_RATE = 25
const MINUTES_PER_HOUR = 60

function safeNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function formatHours(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`
  return `${(minutes / 60).toFixed(1)}h`
}

export default function AiOpportunityPage() {
  const auth = useAuth()
  const canRead = auth.memberships.some((membership) => membership.permissions.includes('ai_agent.read'))
  const [report, setReport] = useState<OverviewReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [automationRate, setAutomationRate] = useState(DEFAULT_AUTOMATION_RATE)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [draftCreated, setDraftCreated] = useState<string | null>(null)

  useEffect(() => {
    if (!canRead) return
    setLoading(true)
    getOverviewReport()
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load opportunity data'))
      .finally(() => setLoading(false))
  }, [canRead])

  const candidates = useMemo<Candidate[]>(() => {
    if (!report) return []
    const categories = report.byCategory.map((item) => ({ key: `category:${item.category}`, label: item.category || 'Uncategorised', kind: 'Category' as const, volume: safeNumber(item.n) }))
    const types = report.byType.map((item) => ({ key: `type:${item.type}`, label: item.type || 'Unknown type', kind: 'Type' as const, volume: safeNumber(item.n) }))
    const teams = report.byTeam.map((item) => ({ key: `team:${item.team}`, label: item.team || 'Unassigned team', kind: 'Team' as const, volume: safeNumber(item.n) }))
    return [...categories, ...types, ...teams].filter((candidate) => candidate.volume > 0).sort((a, b) => b.volume - a.volume).slice(0, 12)
  }, [report])

  const selected = candidates.find((candidate) => candidate.key === selectedKey) ?? candidates[0] ?? null
  const averageMinutes = Math.max(0, safeNumber(report?.resolution.avg_minutes))
  const estimatedAutomatedTickets = selected ? Math.round(selected.volume * automationRate / 100) : 0
  const estimatedHoursSaved = estimatedAutomatedTickets * averageMinutes
  const workerResolutionRate = safeNumber(report?.aiWorkers.resolutionRate)

  const createWorkerDraft = async () => {
    if (!selected || creatingDraft) return
    setCreatingDraft(true)
    setDraftCreated(null)
    try {
      const { playbook } = await createPlaybook({
        name: `${selected.label} automation pilot`,
        description: `Opportunity draft based on ${selected.volume.toLocaleString()} observed ${selected.kind.toLowerCase()} tickets. Validate the workflow with a controlled pilot before enabling it.`,
        category: 'custom',
        trigger_keywords: [selected.label.toLowerCase()],
        system_prompt: `You are a governed ReyDesk L1 worker specialising in ${selected.label}. Read the ticket and linked context first. Diagnose using read-only tools, propose bounded actions, require approval for risky changes, verify every action, and hand off rather than guessing. This playbook was created from an opportunity analysis and must be tested before enablement.`,
        max_steps: 5,
        auto_approve_low_risk: true,
      })
      setDraftCreated(playbook.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create worker draft')
    } finally {
      setCreatingDraft(false)
    }
  }

  if (!canRead) {
    return <Shell><Alert kind="error">You do not have permission to view AI opportunity data.</Alert></Shell>
  }

  return (
    <Shell>
      <div className="ai-opportunity-page">
        <div className="page-head">
          <div>
            <span className="etch">AI opportunity centre</span>
            <h1 className="page-title">Find the work worth automating</h1>
            <p className="page-subtitle">Use your service history to identify repeatable work, estimate the upside, and turn the best candidate into a governed worker playbook.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setLoading(true); getOverviewReport().then(setReport).catch((err) => setError(err instanceof Error ? err.message : 'Could not refresh data')).finally(() => setLoading(false)) }} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh data'}
          </button>
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}
        {loading && !report ? <div className="panel-empty">Analysing your ticket history…</div> : null}
        {report ? (
          <>
            <div className="ai-opportunity-kpis">
              <div className="ai-opportunity-kpi"><span className="etch">Tickets analysed</span><strong>{safeNumber(report.totals.total).toLocaleString()}</strong><small>Current tenant queue</small></div>
              <div className="ai-opportunity-kpi"><span className="etch">Average handling time</span><strong>{formatHours(averageMinutes)}</strong><small>Resolved-ticket average</small></div>
              <div className="ai-opportunity-kpi"><span className="etch">Worker resolution rate</span><strong>{workerResolutionRate.toFixed(1)}%</strong><small>Observed AI worker history</small></div>
              <div className="ai-opportunity-kpi"><span className="etch">Time saved so far</span><strong>{formatHours(safeNumber(report.aiWorkers.timeSavedMinutes))}</strong><small>Recorded worker outcomes</small></div>
            </div>

            <div className="ai-opportunity-layout">
              <section className="panel ai-opportunity-candidates">
                <div className="panel-head">
                  <div className="panel-head-main"><span className="panel-title">Automation candidates</span><span className="panel-sub">Ranked by observed ticket volume, not a generic benchmark.</span></div>
                </div>
                {candidates.length === 0 ? <div className="panel-empty">Not enough ticket history yet. Categorise and resolve more tickets to reveal repeatable work.</div> : (
                  <div className="ai-opportunity-list">
                    {candidates.map((candidate) => {
                      const active = selected?.key === candidate.key
                      return (
                        <button type="button" key={candidate.key} className={`ai-opportunity-candidate${active ? ' active' : ''}`} onClick={() => setSelectedKey(candidate.key)}>
                          <span className="ai-opportunity-candidate-icon"><Icon name={candidate.kind === 'Category' ? 'folder' : candidate.kind === 'Team' ? 'users' : 'ticket'} size={15} /></span>
                          <span className="ai-opportunity-candidate-copy"><strong>{candidate.label}</strong><small>{candidate.kind} · {candidate.volume.toLocaleString()} tickets</small></span>
                          <span className="ai-opportunity-candidate-bar"><span style={{ width: `${Math.min(100, (candidate.volume / Math.max(1, candidates[0]?.volume ?? 1)) * 100)}%` }} /></span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>

              <section className="panel ai-opportunity-planner">
                <div className="panel-head">
                  <div className="panel-head-main"><span className="panel-title">Planning estimate</span><span className="panel-sub">Adjust the assumption before proposing a worker.</span></div>
                </div>
                {selected ? (
                  <div className="ai-opportunity-planner-body">
                    <div className="ai-opportunity-focus"><span className="etch">Selected opportunity</span><strong>{selected.label}</strong><small>{selected.kind} · {selected.volume.toLocaleString()} observed tickets</small></div>
                    <label className="ai-opportunity-slider"><span><span>Potential automation rate</span><strong>{automationRate}%</strong></span><input type="range" min="5" max="80" step="5" value={automationRate} onChange={(event) => setAutomationRate(Number(event.target.value))} /><small>This is a planning assumption, not a promise. Validate it with a pilot.</small></label>
                    <div className="ai-opportunity-estimate"><div><span className="etch">Estimated automated tickets</span><strong>{estimatedAutomatedTickets.toLocaleString()}</strong></div><div><span className="etch">Estimated hours saved</span><strong>{formatHours(estimatedHoursSaved)}</strong></div></div>
                    <div className="ai-opportunity-guardrail"><Icon name="shield" size={16} /><span>Every proposed worker still follows tenant tool permissions, approval gates, and audit logging.</span></div>
                    {draftCreated ? <div className="ai-opportunity-created"><Icon name="check" size={15} /><span>Draft playbook created and disabled by default.</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => window.location.assign(`/ai-workers?playbook=${encodeURIComponent(draftCreated)}`)}>Review draft</button></div> : <button type="button" className="btn btn-primary" onClick={() => void createWorkerDraft()} disabled={creatingDraft}><Icon name="sparkles" size={15} />{creatingDraft ? 'Creating draft…' : 'Create governed worker draft'}</button>}
                  </div>
                ) : <div className="panel-empty">Select a candidate to model its opportunity.</div>}
              </section>
            </div>

            <section className="ai-opportunity-method panel">
              <div><span className="etch">How this works</span><h2>From history to controlled automation</h2></div>
              <ol><li><strong>Observe.</strong> ReyDesk ranks real categories, types, and teams from your ticket history.</li><li><strong>Model.</strong> You choose a conservative automation assumption and see the estimated upside.</li><li><strong>Govern.</strong> The worker is created as a draft and remains subject to permissions, approval thresholds, and audit review.</li></ol>
            </section>
          </>
        ) : null}
      </div>
    </Shell>
  )
}
