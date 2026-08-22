export interface NoxSettings {
  model?: string
  effort?: string
}

const KEY = 'nox.settings'

export async function loadSettings(): Promise<NoxSettings> {
  const stored = await chrome.storage.local.get(KEY)
  return (stored[KEY] as NoxSettings | undefined) ?? {}
}

export async function saveSettings(settings: NoxSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings })
}
