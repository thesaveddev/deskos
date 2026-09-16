import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from './Icons.js'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'

interface OnboardingStep {
  id: string
  title: string
  description: string
  icon: string
  action?: string
  actionPath?: string
}

const steps: OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to ReyDesk',
    description: 'Your IT support platform is ready. Let\'s get you set up in just a few minutes.',
    icon: 'check',
  },
  {
    id: 'invite-team',
    title: 'Invite your team',
    description: 'Add your technicians and support staff so they can start handling tickets.',
    icon: 'users',
    action: 'Invite team members',
    actionPath: '/settings',
  },
  {
    id: 'create-ticket',
    title: 'Create your first ticket',
    description: 'Tickets are the heart of ReyDesk. Create one now to see how the workflow works.',
    icon: 'ticket',
    action: 'Create a ticket',
    actionPath: '/tickets/new',
  },
  {
    id: 'setup-remote',
    title: 'Set up remote support',
    description: 'Deploy the helper agent to endpoints so your team can provide remote assistance.',
    icon: 'monitor',
    action: 'Go to Sessions',
    actionPath: '/sessions',
  },
  {
    id: 'configure-ai',
    title: 'Enable AI workers',
    description: 'Let AI handle routine L1 tasks like password resets and software installs automatically.',
    icon: 'cpu',
    action: 'Configure AI',
    actionPath: '/settings/ai',
  },
  {
    id: 'explore',
    title: 'You\'re all set',
    description: 'Explore the dashboard, knowledge base, and reporting. Your IT support platform is live.',
    icon: 'check',
  },
]

export function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const [currentStep, setCurrentStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const auth = useAuth()
  const step = steps[currentStep]
  const isLast = currentStep === steps.length - 1
  const progress = ((currentStep + 1) / steps.length) * 100

  const handleNext = async () => {
    if (isLast) {
      setBusy(true)
      try {
        await api('/onboarding', {
          method: 'PATCH',
          body: { completed: true },
        })
        onComplete()
      } catch {
        onComplete()
      } finally {
        setBusy(false)
      }
    } else {
      setCurrentStep((s) => s + 1)
    }
  }

  const handleSkip = async () => {
    setBusy(true)
    try {
      await api('/onboarding', {
        method: 'PATCH',
        body: { completed: true },
      })
      onComplete()
    } catch {
      onComplete()
    } finally {
      setBusy(false)
    }
  }

  const handleAction = () => {
    if (step.actionPath) {
      navigate(step.actionPath)
    }
  }

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-panel">
        {/* Progress bar */}
        <div className="onboarding-progress">
          <div className="onboarding-progress-bar" style={{ width: `${progress}%` }} />
        </div>

        {/* Step content */}
        <div className="onboarding-content">
          <div className="onboarding-icon">
            <Icon name={step.icon as any} size={32} />
          </div>
          <h2 className="onboarding-title">{step.title}</h2>
          <p className="onboarding-description">{step.description}</p>

          {step.action && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={handleAction}
              style={{ marginBottom: 16 }}
            >
              {step.action}
              <Icon name="arrow-right" size={14} />
            </button>
          )}
        </div>

        {/* Navigation */}
        <div className="onboarding-nav">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleSkip}
            disabled={busy}
          >
            Skip setup
          </button>
          <div className="onboarding-nav-right">
            {currentStep > 0 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCurrentStep((s) => s - 1)}
              >
                Back
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleNext}
              disabled={busy}
            >
              {busy ? <span className="spinner" aria-hidden="true" /> : null}
              {isLast ? 'Get started' : 'Next'}
            </button>
          </div>
        </div>

        {/* Step indicators */}
        <div className="onboarding-dots">
          {steps.map((s, i) => (
            <span
              key={s.id}
              className={`onboarding-dot ${i === currentStep ? 'active' : ''} ${i < currentStep ? 'done' : ''}`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
