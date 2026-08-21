import { useEffect, useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { LockScreen } from '../components/LockScreen.js'
import { clearLockedUser, readLockedUser } from '../lib/lock.js'

export default function LockPage() {
  const navigate = useNavigate()
  const [user] = useState(() => readLockedUser())

  useEffect(() => {
    if (!user) navigate('/login', { replace: true })
  }, [navigate, user])

  if (!user) return <Navigate to="/login" replace />

  return <LockScreen user={user} onUnlock={() => { clearLockedUser(); navigate('/', { replace: true }) }} />
}
