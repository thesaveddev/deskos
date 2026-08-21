import { useCallback, useEffect, useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { LockScreen } from '../components/LockScreen.js'
import { useAuth } from '../lib/auth.js'
import { clearLockedUser, readLockedUser } from '../lib/lock.js'

export default function LockPage() {
  const navigate = useNavigate()
  const logout = useAuth((state) => state.logout)
  const [user] = useState(() => readLockedUser())

  useEffect(() => {
    if (!user) navigate('/login', { replace: true })
  }, [navigate, user])

  const goToLogin = useCallback(async () => {
    clearLockedUser()
    await logout()
    navigate('/login', { replace: true })
  }, [logout, navigate])

  if (!user) return <Navigate to="/login" replace />

  return (
    <LockScreen
      user={user}
      onUnlock={() => { clearLockedUser(); navigate('/', { replace: true }) }}
      onGoToLogin={goToLogin}
    />
  )
}
