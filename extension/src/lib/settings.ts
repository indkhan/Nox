export interface NoxSettings {
  model?: string
  effort?: string
  serviceTier?: string
  theme?: ThemePreference
}

export type ThemePreference = 'system' | 'light' | 'dark'

const KEY = 'nox.settings'

export async function loadSettings(): Promise<NoxSettings> {
  const stored = await chrome.storage.local.get(KEY)
  return (stored[KEY] as NoxSettings | undefined) ?? {}
}

export async function saveSettings(settings: NoxSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings })
}

export function applyTheme(theme: ThemePreference = 'system'): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}
