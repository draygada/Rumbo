import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import SignIn from '../pages/SignIn/SignIn'
import SignUp from '../pages/SignUp/SignUp'
import ConfirmEmail from '../pages/ConfirmEmail/ConfirmEmail'
import Onboarding from '../pages/Onboarding/Onboarding'
import DashboardLayout from '../pages/Dashboard/DashboardLayout'
import Dashboard from '../pages/Dashboard/Dashboard'
import Settings from '../pages/Settings/Settings'
import Account from '../pages/Account/Account'
import ManualCourses from '../pages/ManualCourses/ManualCourses'
import Brain from '../pages/Brain/Brain'
// AddTask is preserved but not routed in V0 — see Rumbo-Design-Docs/Legacy/scheduler.md.

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
      { path: '/confirm-email', element: <ConfirmEmail /> },
    ],
  },
  {
    element: <PrivateRoute />,
    children: [
      { path: '/onboarding', element: <Onboarding /> },
    ],
  },
  {
    element: <OnboardedRoute />,
    children: [
      {
        element: <DashboardLayout />,
        children: [
          { path: '/dashboard', element: <Dashboard /> },
          { path: '/courses', element: <ManualCourses /> },
          { path: '/brain', element: <Brain /> },
          { path: '/settings', element: <Settings /> },
          { path: '/account', element: <Account /> },
        ],
      },
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
