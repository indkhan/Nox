/** Minimal structural types so history modules stay testable without DOM lib. */
export interface IDBObjectStoreExt {
  createIndex(name: string, keyPath: string | string[]): unknown
}

export interface IDBDatabase {
  createObjectStore(name: string, options?: { keyPath?: string | string[] }): IDBObjectStoreExt
}
