import type { KeyValueStore } from '../storage'

const LOCK_KEY = 'nox.ownerLock'
const HEARTBEAT_MS = 5000

export interface LockInfo {
  windowId: string
  claimedAt: number
}

/**
 * Single-owner lock (MVP §8): the first panel window owns the agent loop;
 * a second window sees "Nox is open in another window". A stale heartbeat
 * (crashed window) can be stolen after 2 missed beats.
 */
export class OwnerLock {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly session: KeyValueStore,
    private readonly now: () => number = Date.now,
    private readonly windowId: string = `win-${Math.random().toString(36).slice(2, 10)}`,
    private readonly heartbeatMs = HEARTBEAT_MS,
  ) {}

  /** Try to become the owner. Resolves false when another live owner exists. */
  async acquire(): Promise<boolean> {
    const existing = await this.read()
    const expired = existing && existing.claimedAt < this.now() - this.heartbeatMs * 2
    if (existing && !expired && existing.windowId !== this.windowId) {
      return false
    }
    await this.write()
    // Let simultaneous claimants publish, then only the surviving claim wins.
    await Promise.resolve()
    if ((await this.read())?.windowId !== this.windowId) return false
    this.timer = setInterval(() => void this.write(), this.heartbeatMs)
    return true
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const existing = await this.read()
    if (existing?.windowId === this.windowId) {
      await this.session.remove(LOCK_KEY)
    }
  }

  /** Who owns it right now (for the "open in another window" message). */
  async owner(): Promise<LockInfo | null> {
    const info = await this.read()
    if (!info) return null
    if (info.claimedAt < this.now() - this.heartbeatMs * 2) return null
    return info
  }

  private async read(): Promise<LockInfo | null> {
    const v = (await this.session.get(LOCK_KEY))[LOCK_KEY] as LockInfo | undefined
    return v ?? null
  }

  private async write(): Promise<void> {
    await this.session.set({ [LOCK_KEY]: { windowId: this.windowId, claimedAt: this.now() } satisfies LockInfo })
  }
}
