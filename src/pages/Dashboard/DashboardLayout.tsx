import { Outlet } from 'react-router-dom'
import Sidebar from '../../components/Sidebar/Sidebar'
import styles from './DashboardLayout.module.css'

export default function DashboardLayout() {
  return (
    <div className={styles.shell}>
      <div className={styles.sidebarCol}>
        <Sidebar />
      </div>
      <main className={styles.main}>
        <div className={styles.mainInner}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
