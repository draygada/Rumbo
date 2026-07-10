export const storeToken = (key: string, value: string) =>
  localStorage.setItem(key, value)

export const getToken = (key: string) =>
  localStorage.getItem(key)

export const removeToken = (key: string) =>
  localStorage.removeItem(key)

export const openExternalUrl = (url: string) =>
  window.open(url, '_blank', 'noopener,noreferrer')

export const closeWindow = () =>
  window.close()

export const onWindowBlur = (callback: () => void) => {
  window.addEventListener('blur', callback)
  return () => window.removeEventListener('blur', callback)
}
