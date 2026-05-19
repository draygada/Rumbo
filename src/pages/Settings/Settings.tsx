import styles from './Settings.module.css'

export default function Settings() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Work hours</h2>
          <p className={styles.sectionDesc}>
            Rumbo never schedules blocks outside this window. Set during onboarding — editing coming soon.
          </p>
          <div className={styles.stub}>Editable in a future update</div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Calendar</h2>
          <p className={styles.sectionDesc}>
            Connect your calendar so Rumbo can schedule around existing events.
          </p>
          <div className={styles.stub}>Google Calendar and Outlook — coming soon</div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Peak hours</h2>
          <p className={styles.sectionDesc}>
            Your preferred working style. Rumbo refines this automatically over time.
          </p>
          <div className={styles.stub}>Editable in a future update</div>
        </section>
      </div>
    </div>
  )
}
