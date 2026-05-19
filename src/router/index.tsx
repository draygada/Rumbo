import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import SignIn from '../pages/SignIn/SignIn'
import SignUp from '../pages/SignUp/SignUp'

// Placeholder pages — filled in later phases
const OnboardingPage = () => <div>Onboarding (Phase 2)</div>
const DashboardPage = () => <div>Dashboard (Phase 3)</div>

function PublicRoute() {
  const { session, profile, loading } = useAuth()
  if (loading) return null
  if (session && profile?.onboarding_completed) return <Navigate to="/dashboard" replace />
  if (session && !profile?.onboarding_completed) return <Navigate to="/onboarding" replace />
  return <Outlet />
}

function PrivateRoute() {
  const { session, loading } = useAuth()
  if (loading) return null
  if (!session) return <Navigate to="/signin" replace />
  return <Outlet />
}

function OnboardedRoute() {
  const { session, profile, loading } = useAuth()
  if (loading) return null
  if (!session) return <Navigate to="/signin" replace />
  if (!profile?.onboarding_completed) return <Navigate to="/onboarding" replace />
  return <Outlet />
}

export const router = createBrowserRouter([
  {
    element: <PublicRoute />,
    children: [
      { path: '/signin', element: <SignIn /> },
      { path: '/signup', element: <SignUp /> },
    ],
  },
  {
    element: <PrivateRoute />,
    children: [
      { path: '/onboarding', element: <OnboardingPage /> },
    ],
  },
  {
    element: <OnboardedRoute />,
    children: [
      { path: '/dashboard', element: <DashboardPage /> },
    ],
  },
  {
    path: '/',
    element: <Navigate to="/signin" replace />,
  },
  {
    path: '*',
    element: <Navigate to="/signin" replace />,
  },
])
