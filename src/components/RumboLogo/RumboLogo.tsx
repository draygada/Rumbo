import RumboMark from '../RumboMark/RumboMark'
import styles from './RumboLogo.module.css'

interface Props {
  className?: string
  variant?: 'sidebar' | 'auth'
}

export default function RumboLogo({ className, variant = 'sidebar' }: Props) {
  const isAuth = variant === 'auth'
  return (
    <span className={[styles.lockup, styles[variant], className].filter(Boolean).join(' ')}>
      <RumboMark size={isAuth ? 40 : 32} variant="anim" title="Rumbo" />
      <span className={styles.word}>Rumbo</span>
    </span>
  )
}
