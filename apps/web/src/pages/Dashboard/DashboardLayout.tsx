import { Outlet } from 'react-router-dom'
import Sidebar from '../../components/Sidebar/Sidebar'
import { useMotionTrack } from '../../spaces/spaceMotion'
import styles from './DashboardLayout.module.css'

export default function DashboardLayout() {
  // The page content trails the swipe and dims through the crossing, so
  // changing space reads as moving the whole app rather than sliding a label in
  // the rail. The transform is written by the gesture's animation loop.
  const contentRef = useMotionTrack('content')

  return (
    <div className={styles.shell}>
      <div className={styles.sidebarCol}>
        <Sidebar />
      </div>
      <main className={styles.main}>
        <div className={styles.mainInner} ref={contentRef}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
