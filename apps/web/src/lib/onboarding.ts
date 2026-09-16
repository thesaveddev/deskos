import { api } from './api.js'

export interface OnboardingStatus {
  completed: boolean
  step: string | null
  completedAt: string | null
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  return api('/onboarding')
}

export async function updateOnboarding(data: { completed: boolean; step?: string }): Promise<void> {
  await api('/onboarding', { method: 'PATCH', body: data })
}
