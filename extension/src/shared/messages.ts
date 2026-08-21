import type { CurrentPage } from './notion-page'

export interface CurrentPageChangedMessage {
  type: 'nox/current-page-changed'
  page: CurrentPage | null
}

export interface GetCurrentPageRequest {
  type: 'nox/get-current-page'
}

export interface GetCurrentPageResponse {
  page: CurrentPage | null
}

export type NoxMessage = CurrentPageChangedMessage

export type NoxRequest = GetCurrentPageRequest
export type NoxResponse = GetCurrentPageResponse

const PREFIX = 'nox/'

export function isNoxMessage(value: unknown): value is NoxMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith(PREFIX)
  )
}
