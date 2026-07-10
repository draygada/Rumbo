import styles from './RumboLogo.module.css'

interface Props {
  className?: string
  variant?: 'sidebar' | 'auth'
}

export default function RumboLogo({ className, variant = 'sidebar' }: Props) {
  return (
    <img
      src="/logo.svg"
      alt="Rumbo"
      className={[styles.logo, styles[variant], className].filter(Boolean).join(' ')}
    />
  )
}
